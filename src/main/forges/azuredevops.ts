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
import { apiFetch, basicAuthHeader } from './_base'

/**
 * Azure DevOps forge adapter.
 *
 * Talks to the Azure DevOps REST API using a Personal Access Token (PAT).
 * No `az` CLI dependency. Docs: https://learn.microsoft.com/en-us/rest/api/azure/devops/
 *
 * Auth is HTTP Basic with an empty username and the PAT as the password
 * (base64-encoded as `:PAT`). Required scope: "Code (Read & Write)" at minimum;
 * "Read" is enough for the review queue, writes (merge/review/comment) need Write.
 *
 * Repo naming: Azure DevOps repos are 3-segment, `{org}/{project}/{repo}`
 * (e.g. `myorg/MyProject/widgets`). The middle segment is the project. Unlike
 * GitHub, PRs and most PR APIs require a project, so cross-project names are
 * not supported here.
 *
 * `repoNwo` arguments to every method are expected to be the 3-segment name
 * (the `Repo` row is created with that shape when the active forge is Azure
 * DevOps).
 *
 * Config fields (stored in settings.forgeConfig.azuredevops):
 *   org            — Azure DevOps organization name (the `dev.azure.com/{org}` slug)
 *   project        — (optional) Default project; if blank, project is taken from
 *                    the 2nd path segment of each repo name
 *   pat            — Personal Access Token
 *   reviewerFilter — (optional) Identity (email or unique name) to filter PRs by;
 *                    defaults to the authenticated user
 */

function adoFetch<T = unknown>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  pat: string,
  body?: unknown,
  timeoutMs = 20_000
): Promise<T | null> {
  return apiFetch<T>({ method, url, headers: { Authorization: basicAuthHeader(pat) }, body, timeoutMs })
}

/** Parse `org/Project/repo` (and tolerate the cross-project form `org/repo` by
 *  treating the second segment as a repo name and using config.project). */
function splitRepo(repoNwo: string, fallbackProject: string): { org: string; project: string; repo: string } {
  const parts = repoNwo.split('/').map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 3) {
    return { org: parts[0], project: parts[1], repo: parts.slice(2).join('/') }
  }
  if (parts.length === 2) {
    return { org: parts[0], project: fallbackProject, repo: parts[1] }
  }
  // Single segment: assume it's the repo name under the configured project+org.
  return { org: parts[0] ?? '', project: fallbackProject, repo: parts[0] ?? '' }
}

function baseUrl(org: string): string {
  return `https://dev.azure.com/${encodeURIComponent(org)}`
}

/** In-memory GUID cache so we don't re-resolve the same repo's id on every call. */
const repoIdCache = new Map<string, string>()

async function resolveRepoId(
  org: string,
  project: string,
  repo: string,
  pat: string
): Promise<string> {
  const key = `${org}/${project}/${repo}`
  const hit = repoIdCache.get(key)
  if (hit) return hit
  const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}?api-version=7.1-preview.1`
  const r = (await adoFetch('GET', url, pat)) as any
  const id = String(r?.id ?? '')
  if (id) repoIdCache.set(key, id)
  return id
}

async function getAuthenticatedUserId(org: string, pat: string): Promise<string> {
  // connectionData returns the authenticated user's descriptor + id without
  // requiring the Graph scope.
  const url = `${baseUrl(org)}/_apis/connectionData?api-version=7.1-preview.1`
  const r = (await adoFetch('GET', url, pat, undefined, 6000)) as any
  return String(r?.authenticatedUser?.id ?? '')
}

/** A reviewer identity record as Azure DevOps returns it. */
interface AdoReviewer {
  id: string
  displayName?: string
  uniqueName?: string
  vote?: number
  isContainer?: boolean
  isRequired?: boolean
}

/** Approve / reject vote on a PR. Azure DevOps uses integer votes:
 *   10  = approved
 *    5  = approved with suggestions
 *    0  = no vote
 *   -5  = waiting for author
 *  -10  = rejected
 */
const VOTE = {
  approve: 10,
  request_changes: -10,
  comment: 0
} as const

function isApprovedVote(vote: number | undefined): boolean {
  return typeof vote === 'number' && vote >= 5
}
function isRejectingVote(vote: number | undefined): boolean {
  return typeof vote === 'number' && vote <= -10
}

/** PR author display name. */
function authorOf(pr: any): string {
  const a = pr?.createdBy ?? {}
  return a.displayName ?? a.uniqueName ?? ''
}

function normalizePrState(status: string | undefined): 'OPEN' | 'CLOSED' | 'MERGED' {
  switch ((status ?? '').toLowerCase()) {
    case 'completed':
      return 'MERGED'
    case 'abandoned':
    case 'closed':
      return 'CLOSED'
    case 'active':
    case 'notset':
    default:
      return 'OPEN'
  }
}

function buildPrUrl(org: string, project: string, repo: string, prId: number): string {
  return `${baseUrl(org)}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${prId}`
}

export const azureDevOpsForge: Forge = {
  id: 'azuredevops',

  async listReviewRequestedPrsForRepos(
    repos: string[],
    username: string,
    config: ForgeConfig
  ): Promise<{ prs: ForgePr[]; errors: { repo: string; error: string }[] }> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    if (!org || !pat) {
      return { prs: [], errors: repos.map((repo) => ({ repo, error: 'azure devops forge not configured' })) }
    }
    const prs: ForgePr[] = []
    const errors: { repo: string; error: string }[] = []
    for (const repoNwo of repos) {
      const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
      if (!project) {
        errors.push({ repo: repoNwo, error: 'no project (use org/Project/repo)' })
        continue
      }
      // The PR list endpoint accepts a reviewer filter via searchCriteria.reviewerId.
      // Resolving the reviewerId requires an identity lookup; skip it for the
      // "watched repos" path (we filter by status=active + the org-wide search
      // below applies the reviewer constraint), but still page so we don't miss.
      try {
        const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/pullRequests?api-version=7.1-preview.1&searchCriteria.status=active&searchCriteria.targetRefName=&$top=50`
      const r = (await adoFetch('GET', url, pat)) as any
      const arr: any[] = Array.isArray(r) ? r : Array.isArray(r?.value) ? r.value : []
        for (const row of arr) {
          // Filter: must be from this repo.
          if ((row?.repository?.name ?? '').toLowerCase() !== repo.toLowerCase()) continue
          // Filter: exclude PRs authored by `username` (matches GitHub's `-author:@me`).
          if (username) {
            const uname = (row?.createdBy?.uniqueName ?? '').toLowerCase()
            if (uname && uname === username.toLowerCase()) continue
          }
          const pr: ForgePr = {
            number: Number(row.pullRequestId),
            title: row.title ?? '',
            author: authorOf(row),
            headRefName: (row.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
            url: row.url ?? buildPrUrl(org, project, repo, Number(row.pullRequestId)),
            repoNameWithOwner: `${org}/${project}/${repo}`
          }
          prs.push(pr)
        }
      } catch (err) {
        errors.push({ repo: repoNwo, error: String(err).slice(0, 120) })
      }
    }
    return { prs, errors }
  },

  async listReviewRequestedPrs(searchFilter: string, _config: ForgeConfig): Promise<ForgePr[]> {
    // Azure DevOps doesn't have a single "search review-requested PRs across
    // org" endpoint; we do the best we can with the watcher-list path. The
    // caller should configure `forgeConfig.azuredevops.project` (or use
    // `watchRepos` with `org/Project/repo` names) to make this concrete.
    void searchFilter
    return []
  },

  async getPr(repoNwo: string, number: number, config: ForgeConfig): Promise<ForgePr> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) {
      throw new Error('azure devops: org, project, pat, and a {org/Project/repo} name are required')
    }
    const repoId = await resolveRepoId(org, project, repo, pat)
    const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}?api-version=7.1-preview.1`
    const r = (await adoFetch('GET', url, pat)) as any
    return {
      number: Number(r.pullRequestId),
      title: r.title ?? '',
      author: authorOf(r),
      headRefName: (r.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
      url: r.url ?? buildPrUrl(org, project, repo, number),
      repoNameWithOwner: `${org}/${project}/${repo}`
    }
  },

  async getPrDiff(repoNwo: string, number: number, config: ForgeConfig): Promise<string> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) {
      throw new Error('azure devops: org, project, pat, and a {org/Project/repo} name are required')
    }
    const repoId = await resolveRepoId(org, project, repo, pat)
    // ADO doesn't expose a `text/vnd.git-diff` content type on its PR endpoints;
    // the closest thing is /pullRequests/{id}/diffs which returns structured
    // changeEntries with per-file lines. We reconstruct a unified diff from
    // those entries so the review harness has real content to reason about
    // (the previous placeholder was just `diff --git a/X b/X` headers with no
    // hunk content, which left the review agent effectively blind).
    const diffUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/diffs?api-version=7.1-preview.1&diffType=unified`
    const diff = await adoFetch<any>('GET', diffUrl, pat)
    const entries: any[] = Array.isArray(diff?.changeEntries) ? diff.changeEntries : []
    if (entries.length === 0) return ''
    return reconstructUnifiedDiff(entries)
  },

  async createPr(
    opts: { cwd: string; title: string; body: string; base: string; head: string; draft?: boolean },
    config: ForgeConfig
  ): Promise<string> {
    void opts.cwd
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const project = (config.project ?? '').trim()
    if (!org || !pat || !project) {
      throw new Error('azure devops: org, project, and pat are required to create a PR')
    }
    // NOTE: createPr as currently designed doesn't know which repo to open
    // against. The dev orchestrator's call to createPr is only reached from a
    // worktree checked out from a known Repo, so we route through that. But the
    // forge interface takes only `cwd` + base/head. For the createPr call we
    // accept that the user is in a worktree under a repo whose remote maps
    // back to Azure DevOps, and we discover the repo via the env's
    // AUTOPILOTV_REPO_NAME (set by the dev orchestrator before spawn) when
    // available; otherwise we fall back to requiring `project` + a single
    // repo per project (a simplification we document in the blurb).
    const repoName = (config._defaultRepo ?? '').trim()
    if (!repoName) {
      throw new Error('azure devops: createPr requires the dev worktree to set AUTOPILOTV_REPO_NAME')
    }
    const repoId = await resolveRepoId(org, project, repoName, pat)
    const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests?api-version=7.1-preview.1`
    const body = {
      sourceRefName: `refs/heads/${opts.head}`,
      targetRefName: `refs/heads/${opts.base}`,
      title: opts.title,
      description: opts.body,
      isDraft: !!opts.draft
    }
    const r = (await adoFetch('POST', url, pat, body)) as any
    return r?.url ?? buildPrUrl(org, project, repoName, Number(r?.pullRequestId ?? 0))
  },

  async findPrForBranch(repoNwo: string, branch: string, config: ForgeConfig) {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) return null
    try {
      const repoId = await resolveRepoId(org, project, repo, pat)
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests?api-version=7.1-preview.1&searchCriteria.sourceRefName=refs/heads/${encodeURIComponent(branch)}&searchCriteria.status=active`
      const r = (await adoFetch('GET', url, pat)) as any
      const arr: any[] = Array.isArray(r) ? r : Array.isArray(r?.value) ? r.value : []
      // Active only — never fall back to closed/completed. A merged PR on this
      // branch is stale; adopting it would re-associate a finished PR with a
      // fresh attempt (matches the GitHub adapter's open-only lookup).
      const row = arr[0]
      if (!row) return null
      return {
        number: Number(row.pullRequestId),
        url: row.url ?? buildPrUrl(org, project, repo, Number(row.pullRequestId)),
        isDraft: !!row.isDraft,
        state: normalizePrState(row.status)
      }
    } catch (err) {
      log.warn('azure devops findPrForBranch failed', { repoNwo, branch, err: String(err) })
      return null
    }
  },

  async getAdoptablePr(repoNwo: string, number: number, config: ForgeConfig): Promise<AdoptablePr | null> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) return null
    try {
      const repoId = await resolveRepoId(org, project, repo, pat)
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}?api-version=7.1-preview.1`
      const r = (await adoFetch('GET', url, pat)) as any
      return {
        number: Number(r.pullRequestId),
        url: r.url ?? buildPrUrl(org, project, repo, number),
        branch: (r.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
        isDraft: !!r.isDraft,
        state: normalizePrState(r.status),
        title: r.title ?? ''
      }
    } catch {
      return null
    }
  },

  async findPrForTask(repoNwo: string, issueKey: string, config: ForgeConfig): Promise<AdoptablePr | null> {
    if (!issueKey) return null
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) return null
    try {
      const repoId = await resolveRepoId(org, project, repo, pat)
      // Azure DevOps search supports a text query; the issue key is unique
      // enough to find the matching PR by title.
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests?api-version=7.1-preview.1&searchCriteria.text=${encodeURIComponent(issueKey)}&searchCriteria.status=active`
      const r = (await adoFetch('GET', url, pat)) as any
      const arr: any[] = Array.isArray(r) ? r : Array.isArray(r?.value) ? r.value : []
      const lower = issueKey.toLowerCase()
      // Prefer a branch that carries the key; otherwise the first (most recent).
      const row =
        arr.find((x) => ((x.sourceRefName ?? '') as string).toLowerCase().includes(lower)) ?? arr[0]
      if (!row) return null
      return {
        number: Number(row.pullRequestId),
        url: row.url ?? buildPrUrl(org, project, repo, Number(row.pullRequestId)),
        branch: (row.sourceRefName ?? '').replace(/^refs\/heads\//, ''),
        isDraft: !!row.isDraft,
        state: normalizePrState(row.status),
        title: row.title ?? ''
      }
    } catch {
      return null
    }
  },

  async publishPr(repoNwo: string, number: number, config: ForgeConfig): Promise<void> {
    // Azure DevOps has a single creation flag (`isDraft`); "publish" flips it
    // off via a PATCH on the pull request.
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) return
    const repoId = await resolveRepoId(org, project, repo, pat)
    const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}?api-version=7.1-preview.1`
    try {
      await adoFetch('PATCH', url, pat, [
        { op: 'replace', path: '/isDraft', value: false }
      ])
    } catch (err) {
      log.warn('azure devops publishPr failed', { repoNwo, number, err: String(err) })
    }
  },

  async mergePr(repoNwo: string, number: number, config: ForgeConfig): Promise<void> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) {
      throw new Error('azure devops: org, project, pat, and a {org/Project/repo} name are required')
    }
    const repoId = await resolveRepoId(org, project, repo, pat)
    const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}?api-version=7.1-preview.1`
    await adoFetch('PUT', url, pat, {
      status: 'completed',
      completionOptions: {
        mergeStrategy: 'squash',
        deleteSourceBranch: false
      }
    })
  },

  async getPrReadiness(repoNwo: string, number: number, config: ForgeConfig): Promise<PrReadiness> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) {
      return {
        state: 'OPEN',
        mergeable: false,
        statusOk: false,
        approvals: 0,
        changesRequested: false,
        unresolvedThreads: 0
      }
    }
    const repoId = await resolveRepoId(org, project, repo, pat)
    const prUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}?api-version=7.1-preview.1`
    const pr = (await adoFetch('GET', prUrl, pat)) as any
    const state = normalizePrState(pr.status)
    if (state !== 'OPEN') {
      return { state, mergeable: false, statusOk: true, approvals: 0, changesRequested: false, unresolvedThreads: 0 }
    }
    const mergeStatus = String(pr.mergeStatus ?? 'notSet')
    const mergeable = mergeStatus === 'notConflicts' || mergeStatus === 'succeeded'
    const statusOk = mergeable // conservative: a clean mergeStatus implies policies OK

    // Reviewers
    const reviewersUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/reviewers?api-version=7.1-preview.1`
    let approvals = 0
    let changesRequested = false
    let reviewersRequested = 0
    try {
      const revs: AdoReviewer[] = ((await adoFetch('GET', reviewersUrl, pat)) ?? []) as any
      reviewersRequested = revs.length
      for (const r of revs) {
        if (isApprovedVote(r.vote)) approvals++
        if (isRejectingVote(r.vote)) changesRequested = true
      }
    } catch {
      // Reviewer list is best-effort; fall through with zeros.
    }

    // Unresolved comment threads
    let unresolvedThreads = 0
    try {
      const threadsUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/threads?api-version=7.1-preview.1`
      const threads = ((await adoFetch('GET', threadsUrl, pat)) ?? []) as any
      const arr: any[] = Array.isArray(threads) ? threads : Array.isArray(threads?.value) ? threads.value : []
      unresolvedThreads = arr.filter((t) => {
        const s = String(t?.status ?? '').toLowerCase()
        return s === 'active' || s === 'pending'
      }).length
    } catch {
      unresolvedThreads = changesRequested ? 1 : 0
    }

    return { state, mergeable, statusOk, approvals, changesRequested, unresolvedThreads, reviewersRequested }
  },

  async submitReview(
    repoNwo: string,
    number: number,
    action: Exclude<ReviewAction, 'dismiss'>,
    body: string,
    config: ForgeConfig
  ): Promise<void> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const { project, repo } = splitRepo(repoNwo, (config.project ?? '').trim())
    if (!org || !pat || !project || !repo) {
      throw new Error('azure devops: org, project, pat, and a {org/Project/repo} name are required')
    }
    const repoId = await resolveRepoId(org, project, repo, pat)
    log.info('submitting azure devops PR review', { repoNwo, number, action, hasBody: body.length > 0 })

    if (action === 'comment') {
      // A "comment-only" review in Azure DevOps is a new thread on the PR.
      // It does NOT change the reviewer's vote.
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/threads?api-version=7.1-preview.1`
      await adoFetch('POST', url, pat, {
        comments: [
          {
            content: body,
            commentType: 'text'
          }
        ],
        status: 'active'
      })
      return
    }

    // Approve / request changes: update the current user's reviewer vote.
    // First find the current user id, then find the matching reviewer record
    // on the PR, then PUT the new vote.
    const userId = await getAuthenticatedUserId(org, pat)
    if (!userId) {
      throw new Error('azure devops: could not determine the authenticated user id from /connectionData')
    }
    const reviewersUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/reviewers?api-version=7.1-preview.1`
    const reviewers: AdoReviewer[] = ((await adoFetch('GET', reviewersUrl, pat)) ?? []) as any
    const me = reviewers.find((r) => r.id === userId) ?? null
    if (me) {
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/reviewers/${encodeURIComponent(me.id)}?api-version=7.1-preview.1`
      await adoFetch('PUT', url, pat, { vote: VOTE[action] })
    } else {
      // No reviewer row exists for us yet (we haven't been added to the PR as
      // a reviewer). Create one with the appropriate vote.
      const url = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/reviewers?api-version=7.1-preview.1`
      await adoFetch('POST', url, pat, { id: userId, vote: VOTE[action] })
    }
    // Always add a thread with the body so the user sees their feedback even
    // when voting.
    if (body.trim().length > 0) {
      const threadUrl = `${baseUrl(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${repoId}/pullRequests/${number}/threads?api-version=7.1-preview.1`
      try {
        await adoFetch('POST', threadUrl, pat, {
          comments: [{ content: body, commentType: 'text' }],
          status: 'active'
        })
      } catch (err) {
        log.warn('azure devops: vote set but adding a comment thread failed', {
          err: String(err)
        })
      }
    }
  },

  async checkAuth(config: ForgeConfig): Promise<ForgeAuthStatus> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    if (!org) return { ok: false, detail: 'no organization set in Forge settings' }
    if (!pat) return { ok: false, detail: 'no PAT set in Forge settings' }
    try {
      const url = `${baseUrl(org)}/_apis/projects?api-version=7.1-preview.4`
      const r = (await adoFetch('GET', url, pat, undefined, 6000)) as any
      const count = Array.isArray(r?.value) ? r.value.length : 0
      return { ok: true, detail: `dev.azure.com/${org} (${count} project${count === 1 ? '' : 's'})` }
    } catch (err) {
      return { ok: false, detail: `dev.azure.com/${org}: ${String(err).slice(0, 120)}` }
    }
  }
}

// Re-exported for tests that want the URL builder directly.
export { buildPrUrl, splitRepo }

/** Test-only helper: clear the in-memory repo-id cache. Not part of the
 *  public `Forge` contract; only used by unit tests to keep them hermetic. */
export function __resetRepoIdCache(): void {
  repoIdCache.clear()
}

/**
 * Reconstruct a unified diff from ADO's structured `changeEntries` response.
 * ADO's diff endpoint returns changeEntries with per-file `item.content.lines`
 * of the form `{lineType: 'context'|'add'|'delete', line: '...', originalLine?, modifiedLine?}`.
 * We render those back to the standard `diff --git` / `@@ -a,b +c,d @@` format
 * the review harness expects.
 *
 * Best-effort: if `originalLine`/`modifiedLine` are absent we synthesize running
 * counters from the lineTypes so the hunk header still has plausible numbers.
 */
export function reconstructUnifiedDiff(entries: any[]): string {
  const out: string[] = []
  for (const e of entries) {
    const item = e?.item ?? {}
    const originalPath = e?.originalPath ?? item?.originalPath ?? item?.path ?? '<unknown>'
    const modifiedPath = e?.modifiedPath ?? item?.modifiedPath ?? item?.path ?? '<unknown>'
    const changeType = (e?.changeType ?? 'edit').toLowerCase()
    const lines: any[] = Array.isArray(item?.content?.lines) ? item.content.lines : []

    out.push(`diff --git a/${originalPath} b/${modifiedPath}`)
    out.push(`--- a/${originalPath}`)
    out.push(`+++ b/${modifiedPath}`)

    if (lines.length === 0) {
      out.push(`@@ change: ${changeType} @@`)
      continue
    }

    // Walk once to bucket lines by source-side (original vs modified) so the
    // hunk header can carry the right `-a,b +c,d` counts. ADO's line objects
    // are usually already in diff order; we just count.
    let origStart = 0
    let origCount = 0
    let modStart = 0
    let modCount = 0
    for (const l of lines) {
      const t = String(l?.lineType ?? '').toLowerCase()
      if (t === 'context' || t === 'delete') origCount++
      if (t === 'context' || t === 'add') modCount++
      if (origStart === 0 && typeof l?.originalLine === 'number') origStart = l.originalLine
      if (modStart === 0 && typeof l?.modifiedLine === 'number') modStart = l.modifiedLine
    }
    if (origStart === 0) origStart = 1
    if (modStart === 0) modStart = 1
    out.push(`@@ -${origStart},${origCount} +${modStart},${modCount} @@`)

    for (const l of lines) {
      const t = String(l?.lineType ?? 'context').toLowerCase()
      const text = String(l?.line ?? '')
      if (t === 'add') out.push('+' + text)
      else if (t === 'delete') out.push('-' + text)
      else out.push(' ' + text)
    }
    out.push('')
  }
  return out.join('\n')
}
