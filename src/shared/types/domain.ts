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
  agentsTemplate: string
  branchPrefix: string
  terminalCommand: string
  theme: string
  onboarded: boolean
}

// The full snapshot pushed to the renderer.
export interface AppState {
  tasks: TrackerTask[]
  trackerProjects: TrackerProject[]
  prReviews: PrReview[]
  reviews: ReviewSummary[]
  sessions: Session[]
  worktrees: Worktree[]
  harnesses: HarnessConfig[]
  repos: Repo[]
  integrations: IntegrationHealth[]
  settings: Settings
  events: AppEvent[]
  brainNotes: BrainNote[]
  appVersion: string
  brain: { lastTickAt: string | null; ticking: boolean; running: boolean; tick: number }
}
