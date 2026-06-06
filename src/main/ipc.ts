import { ipcMain, BrowserWindow, nativeTheme } from 'electron'
import { spawn } from 'child_process'
import { Channels } from '@shared/types/ipc'
import type { NotificationPayload, WorkRef } from '@shared/types/ipc'
import type { HarnessConfig, ReviewAction, Settings } from '@shared/types/domain'
import * as store from './store'
import { resetDatabase } from './db'
import { sessionManager } from './sessions/manager'
import { brain } from './brain/brain'
import { notifier } from './notify'
import { buildState, pushState } from './state'
import { startReview, actOnReview, approveOnly } from './review/orchestrator'
import { pruneWorktree } from './worktree/manager'
import {
  startDevTask,
  delegateDevTask,
  publishDevTask,
  mergeDevTask,
  requestDevChanges,
  resetDevTask
} from './dev/orchestrator'
import { ensureLocalModel, stopLocalModel } from './localmodel/manager'
import { setSecret } from './secrets'
import { makeProvider } from './llm/provider'
import { checkEnvironment } from './env'
import { log } from './log'
import { forgeForRepo } from './forges'
import { exec } from './util/exec'

export function registerIpc(): void {
  handle(Channels.stateSnapshot, async () => buildState())

  handle(Channels.workClaim, async (ref: WorkRef) => {
    const owner = 'user'
    if (!store.claimWork(ref.kind, ref.id, owner)) return
    if (ref.kind === 'review') {
      const pr = store.getPrReview(ref.id)
      if (pr) await startReview(pr)
    } else {
      const task = store.getTask(ref.id)
      if (task) await startDevTask(task)
    }
    pushState()
  })

  handle(Channels.workDelegate, async (ref: WorkRef, prNumber?: number) => {
    if (ref.kind !== 'dev') return
    // Take over even though the brain wouldn't auto-claim it (not a fresh To Do).
    if (!store.claimWork('dev', ref.id, 'user')) return
    const task = store.getTask(ref.id)
    if (task) await delegateDevTask(task, prNumber)
    pushState()
  })

  handle(Channels.workSkip, async (ref: WorkRef) => {
    store.setClaimState(ref.kind, ref.id, 'done')
    if (ref.kind === 'review') store.setPrReviewState(ref.id, 'dismissed')
    else store.setTaskPhase(ref.id, 'done') // dev: leave the queue
    store.recordEvent('work.skipped', { ref })
    pushState()
  })

  handle(Channels.devPublish, async (taskId: number) => {
    await publishDevTask(taskId)
    pushState()
  })

  handle(Channels.devRequestChanges, async (taskId: number, instructions: string) => {
    await requestDevChanges(taskId, instructions)
    pushState()
  })

  handle(Channels.devMerge, async (taskId: number) => {
    await mergeDevTask(taskId)
    pushState()
  })

  handle(Channels.terminalOpen, async (taskId: number) => {
    const task = store.getTask(taskId)
    const wt = task?.worktreeId ? store.getWorktree(task.worktreeId) : null
    if (!wt) return
    openTerminal(wt.path)
    store.recordEvent('terminal.opened', { taskId, path: wt.path })
  })

  handle(Channels.terminalOpenAtPath, async (path: string) => {
    openTerminal(path)
    store.recordEvent('terminal.opened', { path, source: 'rail' })
  })

  handle(Channels.devReset, async (taskId: number) => {
    await resetDevTask(taskId)
    pushState()
  })

  handle(Channels.reviewAct, async (reviewId: number, action: ReviewAction) => {
    await actOnReview(reviewId, action)
    pushState()
  })

  handle(Channels.reviewApprove, async (prReviewId: number) => {
    await approveOnly(prReviewId)
    pushState()
  })

  handle(Channels.reviewReset, async (prReviewId: number) => {
    // Clean up any lingering session/worktree from the failed attempt, then re-queue.
    const pr = store.getPrReview(prReviewId)
    if (pr?.sessionId) {
      const sess = store.getSession(pr.sessionId)
      if (sess) {
        if (sessionManager.isLive(sess.id)) sessionManager.kill(sess.id, 'review reset')
        if (sess.worktreeId) {
          const wt = store.getWorktree(sess.worktreeId)
          if (wt && !wt.prunedAt) await pruneWorktree(wt)
        }
      }
    }
    store.resetPrReview(prReviewId)
    store.recordEvent('review.reset', { prReviewId })
    pushState()
  })

  handle(Channels.sessionSpawn, async (ref: WorkRef) => {
    if (ref.kind === 'review') {
      const pr = store.getPrReview(ref.id)
      const sid = pr ? await startReview(pr) : null
      pushState()
      return sid
    }
    const task = store.getTask(ref.id)
    const sid = task ? await startDevTask(task) : null
    pushState()
    return sid
  })

  handle(Channels.sessionKill, async (sessionId: number) => {
    sessionManager.kill(sessionId, 'killed by user')
    pushState()
  })

  handle(Channels.sessionSendInput, async (sessionId: number, data: string) => {
    sessionManager.write(sessionId, data)
  })

  handle(Channels.sessionGetBuffer, async (sessionId: number) =>
    sessionManager.getSnapshot(sessionId)
  )

  handle(Channels.sessionSetAutoDrive, async (sessionId: number, enabled: boolean) => {
    store.setSessionAutoDrive(sessionId, enabled)
    store.recordEvent('session.autodrive_toggled', { enabled }, { sessionId })
    pushState()
  })

  handle(Channels.harnessUpsert, async (cfg: HarnessConfig) => {
    store.upsertHarness(cfg)
    pushState()
  })

  handle(Channels.harnessDelete, async (id: string) => {
    store.deleteHarness(id)
    pushState()
  })

  handle(Channels.settingsUpdate, async (patch: Partial<Settings>) => {
    store.updateSettings(patch)
    if (patch.theme) nativeTheme.themeSource = patch.theme === 'tomorrow' ? 'light' : 'dark'
    store.recordEvent('settings.updated', { keys: Object.keys(patch) })
    pushState()
  })

  handle(Channels.trackerProjectToggle, async (key: string, enabled: boolean) => {
    store.setTrackerProjectEnabled(key, enabled)
    store.recordEvent('tracker.project_toggled', { key, enabled })
    pushState()
  })

  handle(Channels.trackerProjectSetRepo, async (key: string, repoName: string) => {
    store.setTrackerProjectRepo(key, repoName)
    store.recordEvent('tracker.project_repo_set', { key, repoName })
    pushState()
  })

  handle(Channels.localModelStart, async (harnessId: string) => {
    const h = store.getHarness(harnessId)
    if (h?.localModel) await ensureLocalModel(harnessId, h.localModel)
    pushState()
  })

  handle(Channels.localModelStop, async (harnessId: string) => {
    stopLocalModel(harnessId)
    pushState()
  })

  handle(Channels.brainSetRunning, async (running: boolean) => {
    brain.setRunning(running)
    pushState()
  })

  handle(Channels.brainTickNow, async () => {
    await brain.tick()
    pushState()
  })

  handle(Channels.llmTest, async () => {
    const settings = store.getSettings()
    const provider = makeProvider(settings)
    const started = Date.now()
    try {
      const raw = await provider.judge({
        schemaName: 'ConnectivityTest',
        system: 'You are a connectivity test for an orchestrator. Reply with a single JSON object.',
        user: 'Return exactly {"ok": true, "model": "<the model name you are>"} as JSON.'
      })
      const ms = Date.now() - started
      store.recordEvent('llm.test_ok', { provider: settings.llmProvider, model: settings.llmModel, ms })
      store.recordBrainNote({
        tick: 0,
        category: 'decision',
        message: `LLM connectivity test OK via ${settings.llmProvider} (${settings.llmModel}) in ${ms}ms.`,
        detail: { sample: raw }
      })
      pushState()
      return { ok: true, detail: `${settings.llmProvider}:${settings.llmModel} → ${JSON.stringify(raw).slice(0, 160)}`, ms }
    } catch (err) {
      const ms = Date.now() - started
      store.recordEvent('llm.test_failed', { err: String(err), ms }, { level: 'warn' })
      pushState()
      return { ok: false, detail: String(err).slice(0, 280), ms }
    }
  })

  handle(Channels.envCheck, async () => checkEnvironment())

  handle(Channels.dbWipe, async () => {
    log.warn('wiping database by user request')
    const wasRunning = brain.state.running
    brain.stop()
    await sessionManager.killAll('db_wipe')
    resetDatabase()
    store.seedIfEmpty()
    store.recordEvent('db.wiped', {})
    if (wasRunning) brain.start()
    pushState()
  })

  handle(Channels.secretSet, async (key: string, value: string) => {
    await setSecret(key, value)
    store.recordEvent('secret.set', { key })
  })

  handle(Channels.gitGetDiff, async (opts: { worktreeId?: number; prNumber?: number; repoId?: number }) => {
    if (opts.worktreeId) {
      const wt = store.getWorktree(opts.worktreeId)
      if (!wt) return 'Worktree not found.'
      const repo = store.getRepo(wt.repoId)
      const base = repo?.defaultBranch || 'main'
      // Run diff in the worktree directory.
      // First, get the merge-base diff against origin/defaultBranch to show all changes made on the branch.
      const r = await exec('git', ['diff', `origin/${base}...HEAD`], { cwd: wt.path })
      if (r.code === 0 && r.stdout.trim()) {
        return r.stdout
      }
      // Fallback: get unstaged/staged local changes in the worktree
      const r2 = await exec('git', ['diff', 'HEAD'], { cwd: wt.path })
      return r2.stdout || 'No changes.'
    } else if (opts.prNumber && opts.repoId) {
      const repo = store.getRepo(opts.repoId)
      if (!repo) return 'Repository not found.'
      try {
        const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())
        return await forge.getPrDiff(repo.name, opts.prNumber, forgeConfig)
      } catch (err) {
        return `Failed to fetch PR diff: ${String(err)}`
      }
    }
    return 'No diff context.'
  })

  // ---- main -> renderer wiring ----
  sessionManager.on('output', (chunk) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(Channels.evtSessionOutput, chunk)
    }
  })
  sessionManager.on('status', () => pushState())
  brain.on('changed', () => pushState())
  notifier.on('notification', (n: NotificationPayload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(Channels.evtNotification, n)
    }
  })
}

/**
 * Open a terminal in the given directory. If settings.terminalCommand is set it
 * is used as a template (`{dir}` substituted, split on spaces); otherwise a
 * per-OS default opens kitty.
 */
function openTerminal(cwd: string): void {
  const template = store.getSettings().terminalCommand?.trim()
  let cmd: string
  let args: string[]
  if (template) {
    const parts = template.replace(/\{dir\}/g, cwd).split(/\s+/)
    cmd = parts[0]
    args = parts.slice(1)
  } else if (process.platform === 'darwin') {
    cmd = 'open'
    args = ['-na', 'kitty', '--args', '--directory', cwd]
  } else {
    cmd = 'kitty'
    args = ['--directory', cwd]
  }
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  child.on('error', (e) => log.warn('failed to open terminal', { err: String(e) }))
  child.unref()
}

function handle(channel: string, fn: (...args: any[]) => Promise<unknown>): void {
  ipcMain.handle(channel, async (_evt, ...args) => {
    try {
      return await fn(...args)
    } catch (err) {
      log.error('ipc handler failed', { channel, err: String(err) })
      store.recordEvent('ipc.error', { channel, err: String(err) }, { level: 'error' })
      throw err
    }
  })
}
