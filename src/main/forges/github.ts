import { exec, execOrThrow } from '../util/exec'
import { log } from '../log'
import type { ReviewAction } from '@shared/types/domain'
import type {
  AdoptablePr,
  Forge,
  ForgeAuthStatus,
  ForgeConfig,
  ForgePr,
  PrReadiness
} from './types'

/** GitHub forge adapter. All work goes through the `gh` CLI, which is the
 *  default and historically-only integration. Other forges implement the same
 *  interface but use a REST API directly. */
export const githubForge: Forge = {
  id: 'github',

  async listReviewRequestedPrsForRepos(
    repos: string[],
    username: string,
    _config: ForgeConfig
  ): Promise<{ prs: ForgePr[]; errors: { repo: string; error: string }[] }> {
    const prs: ForgePr[] = []
    const errors: { repo: string; error: string }[] = []
    const search = username ? `review-requested:${username}` : 'review-requested:@me'
    for (const repo of repos) {
      const r = await exec('gh', [
        'pr',
        'list',
        '--repo',
        repo,
        '--search',
        search,
        '--state',
        'open',
        '--json',
        'number,title,author,headRefName,url',
        '--limit',
        '50'
      ])
      if (r.code !== 0) {
        errors.push({ repo, error: (r.stderr || r.stdout).split('\n')[0] ?? 'failed' })
        continue
      }
      const rows = JSON.parse(r.stdout || '[]') as any[]
      for (const row of rows) {
        const author = row.author?.login ?? ''
        if (username && author.toLowerCase() === username.toLowerCase()) continue
        prs.push({
          number: row.number,
          title: row.title,
          author,
          headRefName: row.headRefName,
          url: row.url,
          repoNameWithOwner: repo
        })
      }
    }
    return { prs, errors }
  },

  async listReviewRequestedPrs(searchFilter: string): Promise<ForgePr[]> {
    const r = await exec('gh', [
      'search',
      'prs',
      searchFilter,
      '--json',
      'number,title,author,repository',
      '--limit',
      '50'
    ])
    if (r.code !== 0) {
      throw new Error(`gh search prs failed: ${r.stderr || r.stdout}`)
    }
    const rows = JSON.parse(r.stdout || '[]') as any[]
    return rows.map((row) => ({
      number: row.number,
      title: row.title,
      author: row.author?.login ?? '',
      headRefName: '',
      url: '',
      repoNameWithOwner: row.repository?.nameWithOwner ?? ''
    }))
  },

  async getPr(repoNwo: string, number: number): Promise<ForgePr> {
    const out = await execOrThrow('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      repoNwo,
      '--json',
      'number,title,author,headRefName,url'
    ])
    const row = JSON.parse(out)
    return {
      number: row.number,
      title: row.title,
      author: row.author?.login ?? '',
      headRefName: row.headRefName,
      url: row.url,
      repoNameWithOwner: repoNwo
    }
  },

  async getPrDiff(repoNwo: string, number: number): Promise<string> {
    const r = await exec('gh', ['pr', 'diff', String(number), '--repo', repoNwo], { timeoutMs: 20_000 })
    if (r.code !== 0) throw new Error(`gh pr diff failed: ${r.stderr || r.stdout}`)
    return r.stdout
  },

  async listPrComments(repoNwo: string, number: number): Promise<{ author: string; body: string }[]> {
    const r = await exec(
      'gh',
      ['pr', 'view', String(number), '--repo', repoNwo, '--json', 'comments,reviews'],
      { timeoutMs: 20_000 }
    )
    if (r.code !== 0) return []
    try {
      const row = JSON.parse(r.stdout) as {
        comments?: { author?: { login?: string }; body?: string }[]
        reviews?: { author?: { login?: string }; body?: string }[]
      }
      const out: { author: string; body: string }[] = []
      for (const c of row.comments ?? []) {
        if (c.body) out.push({ author: c.author?.login ?? '', body: c.body })
      }
      for (const c of row.reviews ?? []) {
        if (c.body) out.push({ author: c.author?.login ?? '', body: c.body })
      }
      return out
    } catch {
      return []
    }
  },

  async createPr(opts: {
    cwd: string
    title: string
    body: string
    base: string
    head: string
    draft?: boolean
  }): Promise<string> {
    const args = [
      'pr',
      'create',
      '--title',
      opts.title,
      '--body',
      opts.body,
      '--base',
      opts.base,
      '--head',
      opts.head
    ]
    if (opts.draft) args.push('--draft')
    return (await execOrThrow('gh', args, { cwd: opts.cwd })).trim()
  },

  async findPrForBranch(repoNwo: string, branch: string) {
    const r = await exec('gh', [
      'pr',
      'list',
      '--repo',
      repoNwo,
      '--head',
      branch,
      '--state',
      'all',
      '--json',
      'number,url,isDraft,state',
      '--limit',
      '1'
    ])
    if (r.code !== 0) return null
    const rows = JSON.parse(r.stdout || '[]') as any[]
    if (!rows.length) return null
    return { number: rows[0].number, url: rows[0].url, isDraft: rows[0].isDraft, state: rows[0].state }
  },

  async getAdoptablePr(repoNwo: string, number: number): Promise<AdoptablePr | null> {
    const r = await exec('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      repoNwo,
      '--json',
      'number,url,headRefName,isDraft,state,title'
    ])
    if (r.code !== 0) return null
    const row = JSON.parse(r.stdout)
    return {
      number: row.number,
      url: row.url,
      branch: row.headRefName,
      isDraft: row.isDraft,
      state: row.state,
      title: row.title
    }
  },

  async findPrForTask(repoNwo: string, issueKey: string): Promise<AdoptablePr | null> {
    if (!issueKey) return null
    const r = await exec('gh', [
      'pr',
      'list',
      '--repo',
      repoNwo,
      '--search',
      issueKey,
      '--state',
      'open',
      '--json',
      'number,url,headRefName,isDraft,state,title',
      '--limit',
      '10'
    ])
    if (r.code !== 0) return null
    const rows = JSON.parse(r.stdout || '[]') as any[]
    const key = issueKey.toLowerCase()
    const row = rows.find((x) => (x.headRefName ?? '').toLowerCase().includes(key)) ?? rows[0]
    if (!row) return null
    return {
      number: row.number,
      url: row.url,
      branch: row.headRefName,
      isDraft: row.isDraft,
      state: row.state,
      title: row.title
    }
  },

  async publishPr(repoNwo: string, number: number): Promise<void> {
    await execOrThrow('gh', ['pr', 'ready', String(number), '--repo', repoNwo])
  },

  async mergePr(repoNwo: string, number: number): Promise<void> {
    await execOrThrow('gh', ['pr', 'merge', String(number), '--repo', repoNwo, '--squash'])
  },

  async getPrReadiness(repoNwo: string, number: number): Promise<PrReadiness> {
    const out = await execOrThrow('gh', [
      'pr',
      'view',
      String(number),
      '--repo',
      repoNwo,
      '--json',
      'state,mergeable,reviewDecision,latestReviews,statusCheckRollup'
    ])
    const row = JSON.parse(out)
    const latest: any[] = row.latestReviews ?? []
    const approvals = latest.filter((r) => r.state === 'APPROVED').length
    const changesRequested =
      row.reviewDecision === 'CHANGES_REQUESTED' || latest.some((r) => r.state === 'CHANGES_REQUESTED')

    const checks: any[] = row.statusCheckRollup ?? []
    let statusOk = true
    if (checks.length) {
      const concl = checks.map((c) => c.conclusion ?? c.state ?? '')
      if (concl.some((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c))) statusOk = false
      else if (concl.some((c) => ['PENDING', 'IN_PROGRESS', 'QUEUED', ''].includes(c))) statusOk = false
    }

    let unresolvedThreads = 0
    try {
      const [owner, name] = repoNwo.split('/')
      const q =
        'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{isResolved}}}}}'
      const g = await execOrThrow('gh', [
        'api',
        'graphql',
        '-f',
        `query=${q}`,
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `number=${number}`
      ])
      const nodes = JSON.parse(g).data?.repository?.pullRequest?.reviewThreads?.nodes ?? []
      unresolvedThreads = nodes.filter((n: any) => !n.isResolved).length
    } catch {
      unresolvedThreads = changesRequested ? 1 : 0
    }

    return {
      state: row.state,
      mergeable: row.mergeable === 'MERGEABLE',
      statusOk,
      approvals,
      changesRequested,
      unresolvedThreads
    }
  },

  async submitReview(
    repoNwo: string,
    number: number,
    action: Exclude<ReviewAction, 'dismiss'>,
    body: string
  ): Promise<void> {
    const ACTION_FLAG: Record<Exclude<ReviewAction, 'dismiss'>, string> = {
      approve: '--approve',
      request_changes: '--request-changes',
      comment: '--comment'
    }
    log.info('submitting PR review', { repoNwo, number, action, hasBody: body.length > 0 })
    const args = ['pr', 'review', String(number), '--repo', repoNwo, ACTION_FLAG[action]]
    if (body.trim().length > 0) args.push('--body', body)
    await execOrThrow('gh', args)
  },

  async checkAuth(): Promise<ForgeAuthStatus> {
    const r = await exec('gh', ['auth', 'status'], { timeoutMs: 10_000 })
    return { ok: r.code === 0, detail: (r.stderr || r.stdout).split('\n')[0] ?? '' }
  }
}
