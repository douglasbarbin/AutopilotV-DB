// Core domain types shared across main and renderer.

export type WorkKind = 'dev' | 'review'

export type ClaimState = 'unclaimed' | 'claimed' | 'in_progress' | 'done' | 'error'

export type SessionStatus =
  | 'starting'
  | 'running'
  | 'stalled'
  | 'needs_human'
  | 'exited'
  | 'killed'

export type PrReviewState =
  | 'discovered'
  | 'provisioning'
  | 'review_in_progress'
  | 'awaiting_user'
  | 'submitted'
  | 'dismissed'
  | 'pruned'
  /** The PR merged or closed externally before our review was acted on. */
  | 'superseded'
  | 'error'

export type ReviewAction = 'approve' | 'request_changes' | 'comment' | 'dismiss'

export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'ready_to_merge' | 'done'

/** AutopilotV's own dev lifecycle phase for a claimed task (independent of tracker status). */
export type DevPhase =
  | 'unclaimed'
  | 'implementing'
  | 'draft'
  | 'revising'
  | 'in_review'
  | 'ready_to_merge'
  | 'done'
  | 'error'

export interface Repo {
  id: number
  name: string
  path: string | null
  remote: string
  defaultBranch: string
  cloneState: 'present' | 'missing' | 'cloning'
  /** Which code forge owns this repo (github, azuredevops). Set at upsert time
   *  from the active forge setting; never re-derived afterwards. */
  forge: string
  /** Operator-configured verification command (test/build/lint) run before a
   *  dev PR is surfaced as ready_to_merge. null/undefined = auto-detect or skip.
   *  Superseded by `runbook` when one resolves; kept as the legacy fallback. */
  verifyCommand?: string | null
  /** Operator override of the repo's RUNBOOK.md (narrative + fenced yaml
   *  lifecycle slots). Empty = use the RUNBOOK.md committed in the repo. */
  runbook?: string | null
}

export interface TrackerProject {
  key: string
  name: string
  enabled: boolean
  openCount: number
  repoName: string
}

export interface TrackerTask {
  id: number
  issueKey: string
  projectKey: string
  title: string
  status: TaskStatus
  trackerStatus: string
  assignee: string
  priority: number
  issueType: string
  sprint: string
  phase: DevPhase
  prNumber: number | null
  prUrl: string
  repoId: number | null
  worktreeId: number | null
  claimState: ClaimState
  sessionId: number | null
  updatedAt: string
  /** Commit SHA last run through the verification gate (theme B). Empty until
   *  the first verification; used to avoid re-running on an unchanged commit. */
  verifiedSha: string
  /** PR head commit at which review feedback was last addressed. Stops a sticky
   *  "changes requested" review from re-spawning address-comments every tick. */
  addressedSha: string
  /** Unresolved-thread count when feedback was last addressed. A higher current
   *  count means an additional comment arrived, which re-triggers a round even
   *  on the same commit. */
  addressedThreads: number
}

/** When a verification verdict was produced in the dev lifecycle. */
export type VerifyCheckpoint = 'commit' | 'draft' | 'merge_gate'

/** Pipeline stage names (runbook lifecycle slots) plus the legacy/synthetic kinds. */
export type VerificationKind =
  | 'setup'
  | 'secrets'
  | 'build'
  | 'test'
  | 'app'
  | 'e2e'
  /** Synthetic per-(checkpoint, sha) rollup of all gating stages. */
  | 'pipeline'
  /** Legacy single verify command. */
  | 'command'
  /** Advisory LLM diff-vs-ticket check. */
  | 'spec'

/** One verification verdict for a dev task at a given commit (theme B). */
export interface TaskVerification {
  id: number
  taskId: number
  prNumber: number | null
  commitSha: string
  kind: VerificationKind
  status: 'pass' | 'fail' | 'error' | 'skipped'
  summary: string
  detail: Record<string, unknown>
  checkpoint: VerifyCheckpoint
  createdAt: string
}

export interface PrReview {
  id: number
  prNumber: number
  repoId: number
  repoName: string
  title: string
  author: string
  branch: string
  url: string
  state: PrReviewState
  claimState: ClaimState
  sessionId: number | null
  discoveredAt: string
  updatedAt: string
  /** Forge this PR was discovered on. Copied from the owning repo at upsert. */
  forge: string
}

export interface ReviewFinding {
  severity: 'info' | 'minor' | 'major' | 'blocker'
  file: string
  line?: number
  note: string
}

export interface ReviewSummary {
  id: number
  prReviewId: number
  recommendation: ReviewAction
  summary: string
  findings: ReviewFinding[]
  createdAt: string
  action: ReviewAction | null
  actedAt: string | null
}

export interface Session {
  id: number
  kind: WorkKind
  workRef: string
  harnessId: string
  worktreeId: number | null
  pid: number | null
  status: SessionStatus
  autoDrive: boolean
  autoInjectCount: number
  lastOutputAt: string | null
  startedAt: string
  exitedAt: string | null
  exitReason: string | null
  title: string
}

/** A running app started from a repo runbook's `app` slot (agnostic process). */
export interface AppInstance {
  /** Unique instance name — safe for container/compose project names. */
  id: string
  repoId: number
  repoName: string
  taskId: number | null
  worktreePath: string
  /** Allocated/declared named ports ({port:name} substitutions). */
  ports: Record<string, number>
  pid: number | null
  status: 'starting' | 'ready' | 'exited' | 'failed'
  /** Ready-probe URL with ports substituted, when the runbook declares one. */
  readyUrl: string
  startedAt: string
  exitedAt: string | null
}

export interface Worktree {
  id: number
  path: string
  repoId: number
  branch: string
  kind: WorkKind
  sessionId: number | null
  createdAt: string
  prunedAt: string | null
}

export interface HarnessConfig {
  id: string
  displayName: string
  enabled: boolean
  isReviewDefault: boolean
  isBrainDefault: boolean
  isCodingDefault: boolean
  launch: {
    command: string
    args: string[]
    env?: Record<string, string>
  }
  ready?: { promptPattern?: string }
  stall: {
    idleSeconds: number
    waitingPatterns: string[]
  }
  inject: { method: 'stdin'; submitKey: string }
  localModel?: LocalModelConfig
  reviewPrompt?: string
  /** Pi only: for REVIEW sessions, skip AutopilotV's managed models.json/flags and
   * let Pi use its own (~/.pi) config. No effect unless Pi is the review default. */
  nativeReviewConfig?: boolean
}

export interface LocalModelConfig {
  name: string
  endpoint: string
  start?: { command: string; args: string[] }
  health?: { path: string; timeoutMs: number }
}

export type IntegrationName = 'forge' | 'tracker' | 'llm' | 'localModel'
export type IntegrationStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export interface IntegrationHealth {
  name: IntegrationName
  status: IntegrationStatus
  detail: string
  checkedAt: string
  /** Optional origin tag — e.g. which forge id produced a 'forge' health row. */
  source?: string
}

export interface AppEvent {
  id: number
  ts: string
  level: 'debug' | 'info' | 'warn' | 'error'
  sessionId: number | null
  kind: string
  payload: Record<string, unknown>
}

/** A human-readable line of brain reasoning, surfaced in the Brain view. */
export interface BrainNote {
  id: number
  ts: string
  tick: number
  level: 'debug' | 'info' | 'warn' | 'error'
  category: 'refresh' | 'schedule' | 'reconcile' | 'autodrive' | 'review' | 'dev' | 'decision'
  message: string
  detail: Record<string, unknown>
}

// ──────────────────── post-implementation insights (PM loop) ────────────────────

export type FollowUpKind = 'todo' | 'tech_debt' | 'bug' | 'enhancement' | 'test_gap'
export type FollowUpStatus = 'candidate' | 'created' | 'dismissed'

/** A future-work item harvested from a signal report or post-merge analysis. */
export interface FollowUp {
  id: number
  taskId: number | null
  issueKey: string
  repoId: number | null
  projectKey: string
  title: string
  description: string
  kind: FollowUpKind
  priority: 'low' | 'medium' | 'high'
  files: string[]
  /** Where it came from: 'signal' (agent report) or 'analysis' (post-merge LLM). */
  source: string
  status: FollowUpStatus
  /** Tracker issue key once "Create story" has been clicked. */
  createdIssueKey: string
  createdAt: string
  updatedAt: string
}

export type KnowledgeRole = 'coding' | 'review' | 'brain'
export type KnowledgeStatus = 'candidate' | 'active' | 'retired'

/** A durable learned insight, injected into future sessions' AGENTS.md once active. */
export interface KnowledgeItem {
  id: number
  scope: 'repo' | 'project' | 'global'
  repoId: number | null
  projectKey: string
  role: KnowledgeRole
  insight: string
  evidence: string
  confidence: 'low' | 'medium' | 'high'
  status: KnowledgeStatus
  source: string
  hitCount: number
  lastAppliedAt: string | null
  createdAt: string
  updatedAt: string
}

export type LlmProviderKind = 'local' | 'harness'

export interface Settings {
  pollIntervalSeconds: number
  maxConcurrentSessions: number
  cloneParentDir: string
  tracker: string
  trackerConfig: Record<string, Record<string, string>>
  /** Active code forge. Independent of `tracker` — pick any combination. */
  forge: string
  /** Per-forge config (orgs, PATs, etc.). Keyed by forge id. */
  forgeConfig: Record<string, Record<string, string>>
  githubUsername: string
  watchRepos: string[]
  githubReviewFilter: string
  llmProvider: LlmProviderKind
  llmModel: string
  localLlmEndpoint: string
  autoDrive: {
    enabled: boolean
    maxInjectionsPerSession: number
    destructiveDenylist: string[]
  }
  notifications: {
    reviewReady: boolean
    needsHuman: boolean
    prReadyToMerge: boolean
  }
  mergePolicy: 'await_user'
  autoPublish: boolean
  requiredApprovals: number
  /** Theme B: run the repo's verify command before promoting to ready_to_merge,
   *  blocking promotion and auto-spawning a fix session on failure. */
  verifyBeforeReady: boolean
  /** Theme B: also run the advisory LLM diff-vs-ticket spec-conformance check. */
  verifySpecConformance: boolean
  /** Theme B: max seconds the verify command may run before it's treated as failed. */
  verifyTimeoutSeconds: number
  /** Max concurrently RUNNING app instances (runbook app slot) across all repos. */
  maxRunningApps: number
  agentsTemplate: string
  branchPrefix: string
  terminalCommand: string
  theme: string
  onboarded: boolean
}

// ──────────────────────────── metrics (theme D) ────────────────────────────
// Cost/quality scorecards computed purely from existing history (sessions,
// tasks, events) — time / rework / outcome, no token scraping. Delivered on
// demand via the metrics.get IPC, not as part of the per-push AppState delta.

export interface HarnessScorecard {
  harnessId: string
  displayName: string
  sessionsTotal: number
  sessionsDev: number
  sessionsReview: number
  /** Mean / median duration in minutes over terminal (exited/killed) sessions. */
  avgSessionMinutes: number | null
  medianSessionMinutes: number | null
  endedNeedsHuman: number
  endedKilled: number
  reviewsCaptured: number
  /** Count of review verdicts by recommendation produced under this harness. */
  reviewRecommendations: Record<string, number>
}

export interface DevThroughput {
  tasksMerged: number
  tasksMerged7d: number
  tasksMerged30d: number
  /** Means in minutes; null when there's no completed sample yet. */
  avgTimeToReadyMinutes: number | null
  avgTimeToMergeMinutes: number | null
  /** Mean rework cycles (changes-requested + verification-fix rounds) per merged task. */
  avgReworkCycles: number | null
  resets: number
  /** Fraction of command verifications that passed (0..1), or null if none run. */
  verificationPassRate: number | null
}

export interface ReviewStats {
  completed: number
  recommendations: Record<string, number>
  avgReviewMinutes: number | null
  /** Fraction of acted-on reviews the human approved (0..1), or null. */
  humanApproveRate: number | null
}

/** Learning-loop health: how much the PM/knowledge flywheel is actually turning. */
export interface InsightsStats {
  followupsCandidate: number
  followupsCreated: number
  followupsDismissed: number
  knowledgeCandidate: number
  knowledgeActive: number
  knowledgeRetired: number
  /** Total times active knowledge has been injected into a session's AGENTS.md. */
  knowledgeApplications: number
}

export interface MetricsSnapshot {
  generatedAt: string
  harnesses: HarnessScorecard[]
  dev: DevThroughput
  review: ReviewStats
  insights: InsightsStats
}

// The full snapshot pushed to the renderer.
export interface AppState {
  tasks: TrackerTask[]
  trackerProjects: TrackerProject[]
  prReviews: PrReview[]
  reviews: ReviewSummary[]
  taskVerifications: TaskVerification[]
  sessions: Session[]
  worktrees: Worktree[]
  harnesses: HarnessConfig[]
  repos: Repo[]
  integrations: IntegrationHealth[]
  settings: Settings
  events: AppEvent[]
  brainNotes: BrainNote[]
  followups: FollowUp[]
  knowledge: KnowledgeItem[]
  appInstances: AppInstance[]
  appVersion: string
  brain: { lastTickAt: string | null; ticking: boolean; running: boolean; tick: number }
}
