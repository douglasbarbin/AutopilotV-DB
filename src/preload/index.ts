import { contextBridge, ipcRenderer } from 'electron'
import { Channels, IPC_VERSION } from '@shared/types/ipc'
import type { AutopilotVApi, WorkRef, SessionOutputChunk, NotificationPayload } from '@shared/types/ipc'
import type { AppState, HarnessConfig, ReviewAction, Settings } from '@shared/types/domain'

const api: AutopilotVApi = {
  version: IPC_VERSION,
  snapshot: () => ipcRenderer.invoke(Channels.stateSnapshot) as Promise<AppState>,
  claim: (ref: WorkRef) => ipcRenderer.invoke(Channels.workClaim, ref) as Promise<void>,
  delegate: (ref: WorkRef, prNumber?: number) =>
    ipcRenderer.invoke(Channels.workDelegate, ref, prNumber) as Promise<void>,
  skip: (ref: WorkRef) => ipcRenderer.invoke(Channels.workSkip, ref) as Promise<void>,
  reviewAct: (reviewId: number, action: ReviewAction) =>
    ipcRenderer.invoke(Channels.reviewAct, reviewId, action) as Promise<void>,
  resetReview: (prReviewId: number) =>
    ipcRenderer.invoke(Channels.reviewReset, prReviewId) as Promise<void>,
  approvePr: (prReviewId: number) =>
    ipcRenderer.invoke(Channels.reviewApprove, prReviewId) as Promise<void>,
  publishDev: (taskId: number) => ipcRenderer.invoke(Channels.devPublish, taskId) as Promise<void>,
  requestDevChanges: (taskId: number, instructions: string) =>
    ipcRenderer.invoke(Channels.devRequestChanges, taskId, instructions) as Promise<void>,
  mergeDev: (taskId: number) => ipcRenderer.invoke(Channels.devMerge, taskId) as Promise<void>,
  resetDev: (taskId: number) => ipcRenderer.invoke(Channels.devReset, taskId) as Promise<void>,
  openTerminal: (taskId: number) => ipcRenderer.invoke(Channels.terminalOpen, taskId) as Promise<void>,
  spawnSession: (ref: WorkRef) => ipcRenderer.invoke(Channels.sessionSpawn, ref) as Promise<number>,
  killSession: (sessionId: number) =>
    ipcRenderer.invoke(Channels.sessionKill, sessionId) as Promise<void>,
  sendInput: (sessionId: number, data: string) =>
    ipcRenderer.invoke(Channels.sessionSendInput, sessionId, data) as Promise<void>,
  getSessionBuffer: (sessionId: number) =>
    ipcRenderer.invoke(Channels.sessionGetBuffer, sessionId) as Promise<{ data: string; seq: number }>,
  setSessionAutoDrive: (sessionId: number, enabled: boolean) =>
    ipcRenderer.invoke(Channels.sessionSetAutoDrive, sessionId, enabled) as Promise<void>,
  upsertHarness: (cfg: HarnessConfig) =>
    ipcRenderer.invoke(Channels.harnessUpsert, cfg) as Promise<void>,
  deleteHarness: (id: string) => ipcRenderer.invoke(Channels.harnessDelete, id) as Promise<void>,
  updateSettings: (patch: Partial<Settings>) =>
    ipcRenderer.invoke(Channels.settingsUpdate, patch) as Promise<void>,
  toggleTrackerProject: (key: string, enabled: boolean) =>
    ipcRenderer.invoke(Channels.trackerProjectToggle, key, enabled) as Promise<void>,
  setProjectRepo: (key: string, repoName: string) =>
    ipcRenderer.invoke(Channels.trackerProjectSetRepo, key, repoName) as Promise<void>,
  startLocalModel: (harnessId: string) =>
    ipcRenderer.invoke(Channels.localModelStart, harnessId) as Promise<void>,
  stopLocalModel: (harnessId: string) =>
    ipcRenderer.invoke(Channels.localModelStop, harnessId) as Promise<void>,
  setBrainRunning: (running: boolean) =>
    ipcRenderer.invoke(Channels.brainSetRunning, running) as Promise<void>,
  tickNow: () => ipcRenderer.invoke(Channels.brainTickNow) as Promise<void>,
  wipeDb: () => ipcRenderer.invoke(Channels.dbWipe) as Promise<void>,
  testLlm: () =>
    ipcRenderer.invoke(Channels.llmTest) as Promise<{ ok: boolean; detail: string; ms: number }>,
  checkEnv: () => ipcRenderer.invoke(Channels.envCheck) as Promise<import('@shared/types/ipc').EnvItem[]>,
  setSecret: (key: string, value: string) =>
    ipcRenderer.invoke(Channels.secretSet, key, value) as Promise<void>,
  onState: (cb: (state: AppState) => void) => {
    const fn = (_e: unknown, state: AppState) => cb(state)
    ipcRenderer.on(Channels.evtState, fn)
    return () => ipcRenderer.removeListener(Channels.evtState, fn)
  },
  onSessionOutput: (cb: (chunk: SessionOutputChunk) => void) => {
    const fn = (_e: unknown, chunk: SessionOutputChunk) => cb(chunk)
    ipcRenderer.on(Channels.evtSessionOutput, fn)
    return () => ipcRenderer.removeListener(Channels.evtSessionOutput, fn)
  },
  onNotification: (cb: (n: NotificationPayload) => void) => {
    const fn = (_e: unknown, n: NotificationPayload) => cb(n)
    ipcRenderer.on(Channels.evtNotification, fn)
    return () => ipcRenderer.removeListener(Channels.evtNotification, fn)
  },
  onOpenAbout: (cb: () => void) => {
    const fn = () => cb()
    ipcRenderer.on(Channels.evtOpenAbout, fn)
    return () => ipcRenderer.removeListener(Channels.evtOpenAbout, fn)
  }
}

contextBridge.exposeInMainWorld('autopilotv', api)
