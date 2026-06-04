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
  brainSetRunning: 'brain.setRunning',
  brainTickNow: 'brain.tickNow',
  dbWipe: 'db.wipe',
  llmTest: 'llm.test',
  envCheck: 'env.check',
  secretSet: 'secret.set',
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
  // subscriptions return an unsubscribe fn
  onState(cb: (state: AppState) => void): () => void
  onSessionOutput(cb: (chunk: SessionOutputChunk) => void): () => void
  onNotification(cb: (n: NotificationPayload) => void): () => void
  onOpenAbout(cb: () => void): () => void
  onTrayOpenSettings(cb: () => void): () => void
}
