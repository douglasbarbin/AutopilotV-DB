import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { EventEmitter } from 'events'
import { log } from '../log'
import * as store from '../store'
import { sanitizeChildEnv } from '../util/exec'
import { normalizeTerminalText } from '../util/ansi'
import { substituteVars, type RunbookApp } from '../runbook/runbook'
import type { AppInstance, Repo } from '@shared/types/domain'

/**
 * App instance manager: agnostic process supervision for the runbook `app`
 * slot. AutopilotV's entire opinion is: run the operator's command, optionally
 * hand it ports, wait for the operator's readiness signal, capture logs, and
 * tear it down cleanly. What the command does (Aspire, docker compose, a bare
 * node server) is the project's business.
 *
 * Concurrency rules, themselves agnostic:
 *  - one running instance per repo by default — a project that owns its own
 *    ports cannot run twice without colliding;
 *  - a runbook that declares 'auto' ports has opted into relocation, so
 *    multiple instances of that repo may run concurrently;
 *  - a global cap (settings.maxRunningApps) bounds total load.
 */

interface LiveInstance {
  info: AppInstance
  proc: ChildProcess
  ring: string
  teardown?: string
  vars: { ports: Record<string, number>; instance: string; worktree: string }
}

const RING_MAX = 64 * 1024

export interface StartOutcome {
  ok: boolean
  instance: AppInstance | null
  summary: string
  logTail: string
}

class AppInstanceManager extends EventEmitter {
  private live = new Map<string, LiveInstance>()
  private seq = 0

  list(): AppInstance[] {
    return [...this.live.values()].map((l) => ({ ...l.info }))
  }

  /** Ports of a live instance (for e2e substitutions). */
  portsOf(id: string): Record<string, number> {
    return { ...(this.live.get(id)?.vars.ports ?? {}) }
  }

  logTail(id: string, chars = 4000): string {
    const l = this.live.get(id)
    return l ? normalizeTerminalText(l.ring).slice(-chars) : ''
  }

  private runningForRepo(repoId: number): LiveInstance[] {
    return [...this.live.values()].filter(
      (l) => l.info.repoId === repoId && (l.info.status === 'starting' || l.info.status === 'ready')
    )
  }

  private runningCount(): number {
    return [...this.live.values()].filter(
      (l) => l.info.status === 'starting' || l.info.status === 'ready'
    ).length
  }

  /**
   * Start the repo's app in a worktree and wait for readiness. Resolves with
   * the outcome either way; the instance keeps running on success until
   * stop() is called.
   */
  async start(repo: Repo, worktreePath: string, app: RunbookApp, taskId: number | null): Promise<StartOutcome> {
    const relocatable = Object.values(app.ports).some((v) => v === 'auto')
    if (!relocatable && this.runningForRepo(repo.id).length > 0) {
      return {
        ok: false,
        instance: null,
        summary: `${repo.name} already has a running instance and its runbook declares no 'auto' ports (not relocatable) — refusing a second instance.`,
        logTail: ''
      }
    }
    const cap = store.getSettings().maxRunningApps
    if (this.runningCount() >= cap) {
      return {
        ok: false,
        instance: null,
        summary: `Running-app cap reached (${cap}). Stop an instance or raise maxRunningApps in Settings.`,
        logTail: ''
      }
    }

    const ports: Record<string, number> = {}
    for (const [name, val] of Object.entries(app.ports)) {
      ports[name] = val === 'auto' ? await allocatePort() : val
    }
    this.seq += 1
    const id = `autopilotv-${repo.id}-${this.seq}`
    const vars = { ports, instance: id, worktree: worktreePath }

    const cmd = substituteVars(app.run, vars)
    const env: NodeJS.ProcessEnv = sanitizeChildEnv({ ...process.env })
    for (const [k, v] of Object.entries(app.env)) env[k] = substituteVars(v, vars)

    const isWin = process.platform === 'win32'
    const proc = spawn(isWin ? 'cmd.exe' : '/bin/sh', [isWin ? '/c' : '-c', cmd], {
      cwd: worktreePath,
      env,
      detached: !isWin, // own process group → teardown can kill the whole tree
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const info: AppInstance = {
      id,
      repoId: repo.id,
      repoName: repo.name,
      taskId,
      worktreePath,
      ports,
      pid: proc.pid ?? null,
      status: 'starting',
      readyUrl: app.ready?.url ? substituteVars(app.ready.url, vars) : '',
      startedAt: new Date().toISOString(),
      exitedAt: null
    }
    const li: LiveInstance = { info, proc, ring: '', teardown: app.teardown, vars }
    this.live.set(id, li)
    const onData = (b: Buffer) => {
      li.ring = (li.ring + b.toString()).slice(-RING_MAX)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', () => {
      if (li.info.status !== 'exited') {
        li.info.status = li.info.status === 'ready' ? 'exited' : 'failed'
      }
      li.info.exitedAt = new Date().toISOString()
      this.emit('changed')
    })
    store.recordEvent('app.started', { instance: id, repo: repo.name, taskId, cmd, ports })
    this.emit('changed')

    const ready = await this.waitReady(li, app)
    if (!ready.ok) {
      await this.stop(id, 'failed readiness')
      li.info.status = 'failed'
      this.emit('changed')
      return { ok: false, instance: { ...li.info }, summary: ready.summary, logTail: this.tailOf(li) }
    }
    li.info.status = 'ready'
    store.recordEvent('app.ready', { instance: id, repo: repo.name, ms: ready.ms })
    this.emit('changed')
    return { ok: true, instance: { ...li.info }, summary: ready.summary, logTail: this.tailOf(li) }
  }

  private tailOf(li: LiveInstance, chars = 4000): string {
    return normalizeTerminalText(li.ring).slice(-chars)
  }

  /**
   * Wait for the operator's readiness signal: a URL responding (<500), a log
   * pattern, or — when neither is declared — the process simply surviving a
   * grace period.
   */
  private async waitReady(
    li: LiveInstance,
    app: RunbookApp
  ): Promise<{ ok: boolean; summary: string; ms: number }> {
    const started = Date.now()
    const ready = app.ready
    const timeoutMs = (ready?.timeoutSeconds ?? 300) * 1000

    if (!ready?.url && !ready?.logPattern) {
      await sleep(5000)
      const alive = li.proc.exitCode === null
      return {
        ok: alive,
        summary: alive ? 'process up (no ready probe declared)' : `process exited immediately (code ${li.proc.exitCode})`,
        ms: Date.now() - started
      }
    }

    const url = ready.url ? substituteVars(ready.url, li.vars) : null
    let re: RegExp | null = null
    if (ready.logPattern) {
      try {
        re = new RegExp(ready.logPattern, 'im')
      } catch {
        /* invalid pattern — rely on the URL (or fail below) */
      }
    }

    while (Date.now() - started < timeoutMs) {
      if (li.proc.exitCode !== null) {
        return {
          ok: false,
          summary: `app exited (code ${li.proc.exitCode}) before becoming ready`,
          ms: Date.now() - started
        }
      }
      if (re && re.test(normalizeTerminalText(li.ring))) {
        return { ok: true, summary: `ready (log pattern matched)`, ms: Date.now() - started }
      }
      if (url) {
        try {
          const resp = await fetchWithTimeout(url, 3000)
          if (resp.status < 500) {
            return { ok: true, summary: `ready (${url} → ${resp.status})`, ms: Date.now() - started }
          }
        } catch {
          /* not up yet */
        }
      }
      await sleep(1000)
    }
    return {
      ok: false,
      summary: `not ready within ${Math.round(timeoutMs / 1000)}s (${url ?? ready.logPattern})`,
      ms: Date.now() - started
    }
  }

  /** Teardown command (if declared), then kill the process group. */
  async stop(id: string, reason: string): Promise<void> {
    const li = this.live.get(id)
    if (!li) return
    if (li.teardown && li.proc.exitCode === null) {
      const cmd = substituteVars(li.teardown, li.vars)
      try {
        const { execShell } = await import('../util/exec')
        await execShell(cmd, { cwd: li.info.worktreePath, timeoutMs: 60_000 })
      } catch (err) {
        log.warn('app teardown command failed', { instance: id, err: String(err) })
      }
    }
    killTree(li.proc)
    await sleep(2000)
    if (li.proc.exitCode === null) killTree(li.proc, 'SIGKILL')
    li.info.status = 'exited'
    li.info.exitedAt = li.info.exitedAt ?? new Date().toISOString()
    store.recordEvent('app.stopped', { instance: id, reason })
    this.live.delete(id)
    this.emit('changed')
  }

  async stopForTask(taskId: number, reason: string): Promise<void> {
    for (const li of [...this.live.values()]) {
      if (li.info.taskId === taskId) await this.stop(li.info.id, reason)
    }
  }

  async stopAll(reason: string): Promise<void> {
    for (const id of [...this.live.keys()]) await this.stop(id, reason)
  }
}

function killTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.pid == null || proc.exitCode !== null) return
  try {
    if (process.platform === 'win32') proc.kill(signal)
    else process.kill(-proc.pid, signal) // negative pid → whole process group
  } catch {
    try {
      proc.kill(signal)
    } catch {
      /* already gone */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: ac.signal })
  } finally {
    clearTimeout(t)
  }
}

/** Find a free TCP port by binding to 0 and reading the assignment. */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export const appInstances = new AppInstanceManager()
