// Code-forge adapter contract. Each adapter maps a forge (GitHub, Azure DevOps,
// …) to AutopilotV's neutral PR / review shape. Mirror of src/main/trackers/ —
// both the project tracker AND the code forge are pluggable and independent:
//
//   Jira   + GitHub       ← the historical setup
//   Jira   + Azure DevOps ← e.g. work in Jira, code in Azure Repos
//   Azure DevOps Boards + GitHub
//   …
import type { ReviewAction } from '@shared/types/domain'

/** A pull request from the perspective of the active forge, normalized. */
export interface ForgePr {
  number: number
  title: string
  author: string
  headRefName: string
  url: string
  repoNameWithOwner: string
}

/** A PR that an in-flight task can be handed off to ("take over"). */
export interface AdoptablePr {
  number: number
  url: string
  branch: string
  isDraft: boolean
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  title: string
}

/** Aggregate everything needed to decide if a PR is ready to merge. */
export interface PrReadiness {
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  mergeable: boolean
  statusOk: boolean
  approvals: number
  changesRequested: boolean
  unresolvedThreads: number
}

/** Per-forge config map. Adapters look up the slice they need by `id`. */
export type ForgeConfig = Record<string, string>

/** Lightweight auth/health signal for the integration health dot. */
export interface ForgeAuthStatus {
  ok: boolean
  detail: string
}

export interface Forge {
  id: string

  /** Repo list used by the PR-discovery step in the brain. */
  listReviewRequestedPrsForRepos(
    repos: string[],
    username: string,
    config: ForgeConfig
  ): Promise<{ prs: ForgePr[]; errors: { repo: string; error: string }[] }>

  /** Fallback when no repos are watched: a forge-native search query. */
  listReviewRequestedPrs(searchFilter: string, config: ForgeConfig): Promise<ForgePr[]>

  /** Full PR metadata (head branch, url) for `getPr` lookups. */
  getPr(repoNwo: string, number: number, config: ForgeConfig): Promise<ForgePr>

  /** Unified text diff for the diff viewer. */
  getPrDiff(repoNwo: string, number: number, config: ForgeConfig): Promise<string>

  /** Open a PR from the current worktree (best-effort, no draft check). */
  createPr(
    opts: { cwd: string; title: string; body: string; base: string; head: string; draft?: boolean },
    config: ForgeConfig
  ): Promise<string>

  /** Find an existing PR whose head branch matches, if any. */
  findPrForBranch(
    repoNwo: string,
    branch: string,
    config: ForgeConfig
  ): Promise<{ number: number; url: string; isDraft: boolean; state: string } | null>

  /** Fetch a PR by number with everything needed to adopt it. */
  getAdoptablePr(
    repoNwo: string,
    number: number,
    config: ForgeConfig
  ): Promise<AdoptablePr | null>

  /** Best-effort discovery of an open PR that belongs to a tracker task. */
  findPrForTask(
    repoNwo: string,
    issueKey: string,
    config: ForgeConfig
  ): Promise<AdoptablePr | null>

  /** Mark a draft PR ready for review (no-op for forges without drafts). */
  publishPr(repoNwo: string, number: number, config: ForgeConfig): Promise<void>

  /** Merge a PR (user-initiated). */
  mergePr(repoNwo: string, number: number, config: ForgeConfig): Promise<void>

  /** Aggregate everything needed to decide if a PR is ready to merge. */
  getPrReadiness(
    repoNwo: string,
    number: number,
    config: ForgeConfig
  ): Promise<PrReadiness>

  /** Submit a review (approve / request_changes / comment). */
  submitReview(
    repoNwo: string,
    number: number,
    action: Exclude<ReviewAction, 'dismiss'>,
    body: string,
    config: ForgeConfig
  ): Promise<void>

  /** Connectivity / auth check for the integration health dot. */
  checkAuth(config: ForgeConfig): Promise<ForgeAuthStatus>

  /**
   * Optional: PR conversation bodies (issue comments + review summaries) for
   * post-merge analysis mining. Adapters without an implementation are simply
   * skipped by the analysis engine.
   */
  listPrComments?(
    repoNwo: string,
    number: number,
    config: ForgeConfig
  ): Promise<{ author: string; body: string }[]>
}
