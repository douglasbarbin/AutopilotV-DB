// IPC contract between renderer and main. Versioned, typed DTOs only.
import type {
  AppState,
  HarnessConfig,
  ReviewAction,
  Settings
} from './domain'

export const IPC_VERSION = 1

// Channel names — keep flat and explicit.
export const Channels = {
  // commands (renderer -> main, invoke/handle)
  stateSnapshot: 'state.snapshot',
  workClaim: 'work.claim',
  workDelegate: 'work.delegate',
  workSkip: 'work.skip',
  reviewAct: 'review.act',
  reviewReset: 'review.reset',
  reviewApprove: 'review.approve',
  sessionSpawn: 'session.spawn',
  sessionKill: 'session.kill',
  sessionSendInput: 'session.sendInput',
  sessionGetBuffer: 'session.getBuffer',
  sessionSetAutoDrive: 'session.setAutoDrive',
  harnessUpsert: 'harness.upsert',
  harnessDelete: 'harness.delete',
  settingsUpdate: 'settings.update',
  trackerProjectToggle: 'jira.projectToggle',
  trackerProjectSetRepo: 'jira.projectSetRepo',
  localModelStart: 'localModel.start',
  localModelStop: 'localModel.stop',
  devPublish: 'dev.publish',
  devRequestChanges: 'dev.requestChanges',
  devMerge: 'dev.merge',
  devReset: 'dev.reset',
  terminalOpen: 'terminal.open',
  terminalOpenAtPath: 'terminal.openAtPath',
  brainSetRunning: 'brain.setRunning',
  brainTickNow: 'brain.tickNow',
  dbWipe: 'db.wipe',
  llmTest: 'llm.test',
  envCheck: 'env.check',
  secretSet: 'secret.set',
  gitGetDiff: 'git.getDiff',
  // streams (main -> renderer, send)
  evtState: 'evt.state',
  evtSessionOutput: 'evt.sessionOutput',
  evtNotification: 'evt.notification',
  evtOpenAbout: 'evt.openAbout',
  evtTrayOpenSettings: 'evt.trayOpenSettings'
} as const

// Command payload/response shapes.
export interface WorkRef {
  kind: 'dev' | 'review'
  id: number
}

export interface SessionOutputChunk {
  sessionId: number
  seq: number
  data: string
}

export interface NotificationPayload {
  kind: 'review_ready' | 'needs_human' | 'pr_ready_to_merge'
  title: string
  body: string
  deepLink: { type: 'review' | 'session' | 'task'; id: number }
}

/** One detected tool/dependency in the environment check. */
export interface EnvItem {
  id: string
  label: string
  role: 'required' | 'recommended' | 'optional'
  present: boolean
  authed: boolean | null // null = no auth concept
  detail: string
  install: string // hint / URL
}

/**
 * Which slice(s) of the AppState changed. The renderer uses this to know which
 * sub-components need to re-render. Slices are shallow-compared (a new array
 * reference for collections) so a hook like `useTasks()` can re-render only
 * its callers when tasks changes, and `useSessions()` callers stay quiet.
 */
export type StateSlice =
  | 'tasks'
  | 'trackerProjects'
  | 'prReviews'
  | 'reviews'
  | 'sessions'
  | 'worktrees'
  | 'harnesses'
  | 'repos'
  | 'integrations'
  | 'settings'
  | 'events'
  | 'brainNotes'
  | 'brain'

/**
 * A small change description the main process pushes instead of the full
 * AppState. The full snapshot is still available via `snapshot()` for boot
 * and reconnect. The renderer keeps its local copy of the previous state and
 * applies the changed slices in place — re-render only fires for components
 * subscribed to a slice that was actually listed.
 */
export interface StateDelta {
  version: number
  changed: StateSlice[]
  state: AppState
}

// The typed surface the preload exposes on window.autopilotv.
export interface AutopilotVApi {
  version: number
  snapshot(): Promise<AppState>
  claim(ref: WorkRef): Promise<void>
  /** Take over an in-flight (non-To-Do) task, optionally adopting a specific PR. */
  delegate(ref: WorkRef, prNumber?: number): Promise<void>
  skip(ref: WorkRef): Promise<void>
  reviewAct(reviewId: number, action: ReviewAction): Promise<void>
  resetReview(prReviewId: number): Promise<void>
  approvePr(prReviewId: number): Promise<void>
  publishDev(taskId: number): Promise<void>
  requestDevChanges(taskId: number, instructions: string): Promise<void>
  mergeDev(taskId: number): Promise<void>
  resetDev(taskId: number): Promise<void>
  openTerminal(taskId: number): Promise<void>
  openTerminalAtPath(path: string): Promise<void>
  spawnSession(ref: WorkRef): Promise<number>
  killSession(sessionId: number): Promise<void>
  sendInput(sessionId: number, data: string): Promise<void>
  getSessionBuffer(sessionId: number): Promise<{ data: string; seq: number }>
  setSessionAutoDrive(sessionId: number, enabled: boolean): Promise<void>
  upsertHarness(cfg: HarnessConfig): Promise<void>
  deleteHarness(id: string): Promise<void>
  updateSettings(patch: Partial<Settings>): Promise<void>
  toggleTrackerProject(key: string, enabled: boolean): Promise<void>
  setProjectRepo(key: string, repoName: string): Promise<void>
  startLocalModel(harnessId: string): Promise<void>
  stopLocalModel(harnessId: string): Promise<void>
  setBrainRunning(running: boolean): Promise<void>
  tickNow(): Promise<void>
  wipeDb(): Promise<void>
  testLlm(): Promise<{ ok: boolean; detail: string; ms: number }>
  checkEnv(): Promise<EnvItem[]>
  setSecret(key: string, value: string): Promise<void>
  getDiff(opts: { worktreeId?: number; prNumber?: number; repoId?: number }): Promise<string>
  // subscriptions return an unsubscribe fn
  onState(cb: (state: AppState) => void): () => void
  /**
   * Subscribe to slice-scoped state changes. Returns an unsubscribe fn.
   * The callback receives the full state and the list of changed slices; it
   * can re-render only when the slice it cares about is in `changed`.
   */
  onStateDelta(cb: (delta: StateDelta) => void): () => void
  onSessionOutput(cb: (chunk: SessionOutputChunk) => void): () => void
  onNotification(cb: (n: NotificationPayload) => void): () => void
  onOpenAbout(cb: () => void): () => void
  onTrayOpenSettings(cb: () => void): () => void
}
