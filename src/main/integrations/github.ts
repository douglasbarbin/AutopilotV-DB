import { exec, execOrThrow } from '../util/exec'
import { log } from '../log'
import type { ReviewAction } from '@shared/types/domain'

export interface GhPr {
  number: number
  title: string
  author: string
  headRefName: string
  url: string
  repoNameWithOwner: string
}

export interface GhCiState {
  number: number
  reviewDecision: string | null // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | null
  mergeable: string // MERGEABLE | CONFLICTING | UNKNOWN
  statusRollup: 'SUCCESS' | 'FAILURE' | 'PENDING' | 'NONE'
  state: 'OPEN' | 'CLOSED' | 'MERGED'
}

/** PRs where review is requested from the current user and authored by someone else. */
export async function listReviewRequestedPrs(searchFilter: string): Promise<GhPr[]> {
  // The filter must be passed as a SINGLE argument: GitHub search qualifiers like
  // `-author:@me` look like CLI flags if split into separate args.
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
  // gh search doesn't return headRefName; fetch branch per-PR lazily where needed.
  return rows.map((row) => ({
    number: row.number,
    title: row.title,
    author: row.author?.login ?? '',
    headRefName: '',
    url: '',
    repoNameWithOwner: row.repository?.nameWithOwner ?? ''
  }))
}

/**
 * Reliable, explicit discovery: for each watched repo, list open PRs where review
 * is requested from `username`, excluding PRs authored by them. Uses `gh pr list
 * --search` (repo-scoped) so there is no `@me` global-search ambiguity, and it
 * returns the head branch directly.
 */
export async function listReviewRequestedPrsForRepos(
  repos: string[],
  username: string
): Promise<{ prs: GhPr[]; errors: { repo: string; error: string }[] }> {
  const prs: GhPr[] = []
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
      if (username && author.toLowerCase() === username.toLowerCase()) continue // skip my own
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
}

/** Fetch full PR metadata (branch, url) for a given repo + number. */
export async function getPr(repoNwo: string, number: number): Promise<GhPr> {
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
}

export async function getPrCiState(repoNwo: string, number: number): Promise<GhCiState> {
  const out = await execOrThrow('gh', [
    'pr',
    'view',
    String(number),
    '--repo',
    repoNwo,
    '--json',
    'number,reviewDecision,mergeable,statusCheckRollup,state'
  ])
  const row = JSON.parse(out)
  const checks: any[] = row.statusCheckRollup ?? []
  let rollup: GhCiState['statusRollup'] = 'NONE'
  if (checks.length) {
    const concl = checks.map((c) => c.conclusion ?? c.state ?? '')
    if (concl.some((c) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT'].includes(c)))
      rollup = 'FAILURE'
    else if (concl.some((c) => ['PENDING', 'IN_PROGRESS', 'QUEUED', ''].includes(c)))
      rollup = 'PENDING'
    else rollup = 'SUCCESS'
  }
  return {
    number: row.number,
    reviewDecision: row.reviewDecision ?? null,
    mergeable: row.mergeable ?? 'UNKNOWN',
    statusRollup: rollup,
    state: row.state
  }
}

const ACTION_FLAG: Record<Exclude<ReviewAction, 'dismiss'>, string> = {
  approve: '--approve',
  request_changes: '--request-changes',
  comment: '--comment'
}

/** Submit a review to GitHub. Performed only by the (sandbox-free) main process. */
export async function submitReview(
  repoNwo: string,
  number: number,
  action: Exclude<ReviewAction, 'dismiss'>,
  body: string
): Promise<void> {
  log.info('submitting PR review', { repoNwo, number, action, hasBody: body.length > 0 })
  const args = ['pr', 'review', String(number), '--repo', repoNwo, ACTION_FLAG[action]]
  if (body.trim().length > 0) args.push('--body', body)
  await execOrThrow('gh', args)
}

export async function createPr(opts: {
  cwd: string
  title: string
  body: string
  base: string
  head: string
  draft?: boolean
}): Promise<string> {
  const args = ['pr', 'create', '--title', opts.title, '--body', opts.body, '--base', opts.base, '--head', opts.head]
  if (opts.draft) args.push('--draft')
  return (await execOrThrow('gh', args, { cwd: opts.cwd })).trim()
}

/** Find an open PR for a given head branch in a repo, if one exists. */
export async function findPrForBranch(
  repoNwo: string,
  branch: string
): Promise<{ number: number; url: string; isDraft: boolean; state: string } | null> {
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
}

/** A PR that an in-flight task can be handed off to ("take over"). */
export interface AdoptablePr {
  number: number
  url: string
  branch: string
  isDraft: boolean
  state: string // OPEN | CLOSED | MERGED
  title: string
}

/** Fetch a PR by number with everything needed to adopt it, or null if absent. */
export async function getAdoptablePr(repoNwo: string, number: number): Promise<AdoptablePr | null> {
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
}

/**
 * Best-effort discovery of an open PR that belongs to a tracker task, matched by
 * the issue key appearing in the PR title/body or head branch. Returns the most
 * recent match, or null. Used by "take over" when no PR number is supplied.
 */
export async function findPrForTask(repoNwo: string, jiraKey: string): Promise<AdoptablePr | null> {
  if (!jiraKey) return null
  const r = await exec('gh', [
    'pr',
    'list',
    '--repo',
    repoNwo,
    '--search',
    jiraKey,
    '--state',
    'open',
    '--json',
    'number,url,headRefName,isDraft,state,title',
    '--limit',
    '10'
  ])
  if (r.code !== 0) return null
  const rows = JSON.parse(r.stdout || '[]') as any[]
  const key = jiraKey.toLowerCase()
  // Prefer a branch that carries the key; otherwise the first (most-recent) match.
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
}

/** Mark a draft PR ready for review (publish). */
export async function publishPr(repoNwo: string, number: number): Promise<void> {
  await execOrThrow('gh', ['pr', 'ready', String(number), '--repo', repoNwo])
}

/** Merge a PR (user-initiated). Defaults to squash. */
export async function mergePr(repoNwo: string, number: number): Promise<void> {
  await execOrThrow('gh', ['pr', 'merge', String(number), '--repo', repoNwo, '--squash'])
}

export interface PrReadiness {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeable: boolean
  statusOk: boolean
  approvals: number
  changesRequested: boolean
  unresolvedThreads: number
}

/** Aggregate everything needed to decide if a PR is ready to merge. */
export async function getPrReadiness(repoNwo: string, number: number): Promise<PrReadiness> {
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
    // GraphQL unavailable — approximate with the review decision.
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
}

export async function checkAuth(): Promise<{ ok: boolean; detail: string }> {
  const r = await exec('gh', ['auth', 'status'], { timeoutMs: 10_000 })
  return { ok: r.code === 0, detail: (r.stderr || r.stdout).split('\n')[0] ?? '' }
}
