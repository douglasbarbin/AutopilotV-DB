import * as pty from 'node-pty'
import { EventEmitter } from 'events'
import { app } from 'electron'
import { createWriteStream, mkdirSync, rmSync, type WriteStream } from 'fs'
import { join } from 'path'
import { log } from '../log'
import * as store from '../store'
import type { HarnessConfig, SessionStatus, WorkKind } from '@shared/types/domain'
import type { SessionOutputChunk } from '@shared/types/ipc'
import { preparePiLocalModel, substitute } from './localHarness'
import { sanitizeChildEnv } from '../util/exec'
import { quiescenceFingerprint } from '../util/ansi'
import {
  KICKOFF_POLL_MS,
  KICKOFF_ECHO_TIMEOUT_MS,
  KICKOFF_ECHO_GRACE_MS,
  KICKOFF_SUBMIT_SETTLE_MS,
  KEY_SEQUENCES,
  isReadyForPrompt,
  judgeEcho,
  type EchoVerdict,
  type KeyName
} from './kickoff'

interface LiveSession {
  id: number
  proc: pty.IPty
  seq: number
  ring: string // bounded tail buffer
  transcript: WriteStream
  transcriptPath: string
  harness: HarnessConfig
  /** Wall-clock spawn time, for kickoff readiness probing. */
  spawnedAt: number
  /** The task prompt this session was started with (context for stall judgment). */
  initialInput: string | null
  /** Stability fingerprint of the visible tail + when it last changed. */
  visibleFp: string
  visibleChangedAt: number
}

const RING_MAX = 64 * 1024
/** Window of the ring buffer that feeds the visible-quiescence fingerprint. */
const FP_WINDOW = 2048

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface SpawnOptions {
  kind: WorkKind
  workRef: string
  harness: HarnessConfig
  cwd: string
  env: NodeJS.ProcessEnv
  worktreeId: number | null
  title: string
  /** Initial prompt/command written to the PTY once it is ready. */
  initialInput?: string
}

export declare interface SessionManager {
  on(e: 'output', cb: (c: SessionOutputChunk) => void): this
  on(e: 'status', cb: (id: number, status: SessionStatus) => void): this
}

export class SessionManager extends EventEmitter {
  private live = new Map<number, LiveSession>()
  private transcriptsDir: string

  constructor() {
    super()
    this.transcriptsDir = join(app.getPath('userData'), 'transcripts')
    mkdirSync(this.transcriptsDir, { recursive: true })
  }

  spawn(opts: SpawnOptions): number {
    const sessionId = store.createSession({
      kind: opts.kind,
      workRef: opts.workRef,
      harnessId: opts.harness.id,
      worktreeId: opts.worktreeId,
      title: opts.title
    })

    // If the harness is backed by a local model, point it at the endpoint.
    const lm = opts.harness.localModel
    const isPi = opts.harness.launch.command === 'pi'
    // Opt-out: let Pi use its own ~/.pi config for review sessions.
    const bypassPiManaged = isPi && !!opts.harness.nativeReviewConfig && opts.kind === 'review'

    let lmEnv: Record<string, string> = {}
    let args = substitute(opts.harness.launch.args, lm)

    if (lm && !bypassPiManaged) {
      if (isPi) {
        // Managed Pi: isolated models.json (PI_CODING_AGENT_DIR) + provider/model flags.
        lmEnv = { ...preparePiLocalModel(lm) }
        args = ['--provider', 'lmstudio', '--model', lm.name, ...args]
      } else {
        // Generic OpenAI-compatible harness.
        lmEnv = {
          OPENAI_BASE_URL: `${lm.endpoint}/v1`,
          OPENAI_API_BASE: `${lm.endpoint}/v1`,
          OPENAI_API_KEY: 'local',
          AGENT_MODEL: lm.name
        }
      }
    }

    // Claude must always run with permission-mode auto — guarantee it at spawn
    // time regardless of what's stored, and drop any stale/invalid flags.
    if (opts.harness.launch.command === 'claude') {
      args = args.filter((a) => !['--dangerously-skip-permissions', '--enable', 'auto-mode'].includes(a))
      if (!args.includes('--permission-mode')) args = ['--permission-mode', 'auto', ...args]
    }

    // Pi must autotrust the working folder — append -a at spawn time.
    if (isPi && !args.includes('-a')) {
      args = [...args, '-a']
    }

    let proc: pty.IPty
    try {
      proc = pty.spawn(opts.harness.launch.command, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 32,
        cwd: opts.cwd,
        // sanitizeChildEnv strips npm lifecycle vars (npm_config_local_prefix,
        // INIT_CWD, …) that point at AutopilotV's own repo and would corrupt
        // npm resolution inside the session's worktree.
        env: sanitizeChildEnv({
          ...opts.env,
          // Advertise full 24-bit truecolor support so tools like bat, delta,
          // lazygit, rich, etc. render with their full color output without
          // needing any extra user configuration.
          TERM: 'xterm-256color',
          COLORTERM: 'truecolor',
          ...lmEnv,
          ...(opts.harness.launch.env ?? {})
        }) as { [k: string]: string }
      })
    } catch (err) {
      // The PTY never came up (missing binary, bad cwd, posix_spawn failure).
      // Without this, the session row stays 'starting' forever with no live
      // entry — the exact unkillable state. Mark it dead at the source.
      log.warn('harness failed to launch', { sessionId, command: opts.harness.launch.command, err: String(err) })
      store.setSessionStatus(sessionId, 'killed', `launch failed: ${String(err).slice(0, 160)}`)
      store.recordEvent(
        'session.launch_failed',
        { harness: opts.harness.id, command: opts.harness.launch.command, err: String(err).slice(0, 200) },
        { level: 'warn', sessionId }
      )
      this.emit('status', sessionId, 'killed')
      return sessionId
    }

    const transcriptPath = join(this.transcriptsDir, `session-${sessionId}.log`)
    const transcript = createWriteStream(transcriptPath, { flags: 'a' })

    const ls: LiveSession = {
      id: sessionId,
      proc,
      seq: 0,
      ring: '',
      transcript,
      transcriptPath,
      harness: opts.harness,
      spawnedAt: Date.now(),
      initialInput: opts.initialInput ?? null,
      visibleFp: '',
      visibleChangedAt: Date.now()
    }
    this.live.set(sessionId, ls)

    store.setSessionPid(sessionId, proc.pid)
    store.setSessionStatus(sessionId, 'running')
    this.emit('status', sessionId, 'running')
    store.recordEvent(
      'session.spawned',
      { harness: opts.harness.id, kind: opts.kind, workRef: opts.workRef, cwd: opts.cwd },
      { sessionId }
    )

    proc.onData((data) => {
      ls.seq += 1
      ls.ring = (ls.ring + data).slice(-RING_MAX)
      // Track when the VISIBLE screen content last changed, ignoring spinner
      // frames and timers — raw byte flow keeps lastOutputAt fresh forever on
      // an animated TUI, which is exactly what masked stuck-at-prompt stalls.
      const fp = quiescenceFingerprint(ls.ring.slice(-FP_WINDOW))
      if (fp !== ls.visibleFp) {
        ls.visibleFp = fp
        ls.visibleChangedAt = Date.now()
      }
      ls.transcript.write(data)
      store.markSessionOutput(sessionId)
      this.emit('output', { sessionId, seq: ls.seq, data })
    })

    proc.onExit(({ exitCode, signal }) => {
      log.info('session exited', { sessionId, exitCode, signal })
      const reason = signal ? `signal ${signal}` : `exit ${exitCode}`
      const current = store.getSession(sessionId)
      // If we deliberately killed it, status is already 'killed'.
      const status: SessionStatus = current?.status === 'killed' ? 'killed' : 'exited'
      store.setSessionStatus(sessionId, status, reason)
      this.emit('status', sessionId, status)
      try {
        ls.transcript.end()
      } catch {
        /* ignore */
      }
      // The captured terminal buffer is only needed while the session is live;
      // discard the on-disk transcript once the session closes.
      try {
        rmSync(ls.transcriptPath, { force: true })
      } catch {
        /* ignore */
      }
      this.live.delete(sessionId)
    })

    if (opts.initialInput) {
      void this.kickoff(ls, opts.initialInput)
    }

    return sessionId
  }

  /**
   * Closed-loop kickoff: wait until the harness TUI looks ready (per-harness
   * ready pattern, or visible-output quiescence, capped by a boot-wait
   * ceiling), type the prompt, wait for it to echo back, then send a SEPARATE
   * submit keypress — interactive TUIs don't run on the text alone. If the
   * keystrokes visibly went nowhere, the prompt is retyped once before
   * submitting; either way the outcome is recorded so stall judgment knows
   * whether this session verifiably received its task.
   */
  private async kickoff(ls: LiveSession, initialInput: string): Promise<void> {
    const sessionId = ls.id
    const text = initialInput.replace(/[\r\n]+$/, '')
    const submit = ls.harness.inject.submitKey || '\r'

    // 1. readiness
    while (this.live.has(sessionId)) {
      const ready = isReadyForPrompt(
        {
          buffer: ls.ring,
          elapsedMs: Date.now() - ls.spawnedAt,
          msSinceVisibleChange: ls.seq > 0 ? Date.now() - ls.visibleChangedAt : null
        },
        ls.harness.ready?.promptPattern
      )
      if (ready) break
      await sleep(KICKOFF_POLL_MS)
    }
    if (!this.live.has(sessionId)) return
    const readyMs = Date.now() - ls.spawnedAt

    // 2. type the prompt
    const bufferBeforeTyping = ls.ring
    this.write(sessionId, text)

    // 3. wait for the echo
    let verdict: EchoVerdict = 'proceed'
    let retyped = false
    const typedAt = Date.now()
    while (this.live.has(sessionId) && Date.now() - typedAt < KICKOFF_ECHO_TIMEOUT_MS) {
      verdict = judgeEcho(bufferBeforeTyping, ls.ring, text)
      if (verdict === 'echoed') break
      if (verdict === 'retype' && !retyped && Date.now() - typedAt >= KICKOFF_ECHO_GRACE_MS) {
        retyped = true
        this.write(sessionId, text)
      }
      await sleep(KICKOFF_POLL_MS)
    }
    if (!this.live.has(sessionId)) return

    // 4. submit
    await sleep(KICKOFF_SUBMIT_SETTLE_MS)
    this.write(sessionId, submit)
    const echoVerified = verdict === 'echoed'
    store.recordEvent(
      'session.kickoff',
      { via: 'initial-input', readyMs, echoVerified, retyped },
      { sessionId, level: echoVerified ? 'info' : 'warn' }
    )
    if (!echoVerified) {
      log.warn('kickoff prompt did not visibly echo; submitted anyway', { sessionId, retyped })
    }
  }

  write(sessionId: number, data: string): void {
    const ls = this.live.get(sessionId)
    if (!ls) return
    ls.proc.write(data)
  }

  /** Inject a response followed by the harness submit key. */
  inject(sessionId: number, response: string): void {
    const ls = this.live.get(sessionId)
    if (!ls) return
    ls.proc.write(response + ls.harness.inject.submitKey)
  }

  /** Press raw named keys (no submit key appended). */
  sendKeys(sessionId: number, keys: KeyName[]): void {
    const ls = this.live.get(sessionId)
    if (!ls) return
    ls.proc.write(keys.map((k) => KEY_SEQUENCES[k]).join(''))
  }

  /** The task prompt this session was started with, if any. */
  getInitialInput(sessionId: number): string | null {
    return this.live.get(sessionId)?.initialInput ?? null
  }

  /**
   * Seconds since the VISIBLE terminal content last changed (spinner frames and
   * timers excluded), or null when the session isn't live or hasn't output yet.
   */
  secondsSinceVisibleChange(sessionId: number): number | null {
    const ls = this.live.get(sessionId)
    if (!ls || ls.seq === 0) return null
    return (Date.now() - ls.visibleChangedAt) / 1000
  }

  getTail(sessionId: number, bytes = 4096): string {
    const ls = this.live.get(sessionId)
    return ls ? ls.ring.slice(-bytes) : ''
  }

  getBuffer(sessionId: number): string {
    return this.live.get(sessionId)?.ring ?? ''
  }

  /** Current captured buffer + the latest sequence number, for replay on view. */
  getSnapshot(sessionId: number): { data: string; seq: number } {
    const ls = this.live.get(sessionId)
    return ls ? { data: ls.ring, seq: ls.seq } : { data: '', seq: 0 }
  }

  isLive(sessionId: number): boolean {
    return this.live.has(sessionId)
  }

  kill(sessionId: number, reason: string): void {
    const ls = this.live.get(sessionId)
    if (!ls) {
      // No live PTY (launch failed, orphaned, already reaped): a kill must
      // still STICK in the bookkeeping, or the row wedges in an active status
      // the UI can never clear.
      const current = store.getSession(sessionId)
      if (current && ['starting', 'running', 'stalled', 'needs_human'].includes(current.status)) {
        store.setSessionStatus(sessionId, 'killed', `${reason} (no live process)`)
        store.recordEvent('session.killed', { reason, orphan: true }, { sessionId })
        this.emit('status', sessionId, 'killed')
      }
      return
    }
    store.setSessionStatus(sessionId, 'killed', reason)
    store.recordEvent('session.killed', { reason }, { sessionId })
    this.emit('status', sessionId, 'killed')

    // Escalating kill: TERM the process group (harnesses spawn children), then
    // KILL anything still alive after a grace period, then force the cleanup
    // even if the kernel won't reap it — the UI must never show an
    // un-dismissable session.
    this.signal(ls, 'SIGTERM')
    setTimeout(() => {
      if (!this.live.has(sessionId)) return
      this.signal(ls, 'SIGKILL')
      setTimeout(() => {
        if (this.live.has(sessionId)) this.forceCleanup(sessionId, 'kill timeout')
      }, 2000)
    }, 2500)
  }

  /** Signal the session's process group, falling back to the PTY leader. */
  private signal(ls: LiveSession, sig: NodeJS.Signals): void {
    try {
      process.kill(-ls.proc.pid, sig)
    } catch {
      try {
        ls.proc.kill(sig)
      } catch {
        /* already gone */
      }
    }
  }

  /** Last resort: drop the bookkeeping for a process that won't die. */
  private forceCleanup(sessionId: number, why: string): void {
    const ls = this.live.get(sessionId)
    if (!ls) return
    log.warn('session process unresponsive to SIGKILL; dropping bookkeeping', { sessionId, pid: ls.proc.pid, why })
    store.recordEvent('session.force_cleaned', { pid: ls.proc.pid, why }, { level: 'warn', sessionId })
    try {
      ls.transcript.end()
    } catch {
      /* ignore */
    }
    try {
      rmSync(ls.transcriptPath, { force: true })
    } catch {
      /* ignore */
    }
    this.live.delete(sessionId)
    this.emit('status', sessionId, 'killed')
  }

  /** Graceful shutdown: SIGTERM then SIGKILL after a grace period. */
  async killAll(reason: string, graceMs = 3000): Promise<void> {
    const ids = [...this.live.keys()]
    for (const id of ids) {
      const ls = this.live.get(id)
      if (!ls) continue
      store.setSessionStatus(id, 'killed', reason)
      try {
        ls.proc.kill('SIGTERM')
      } catch {
        /* ignore */
      }
    }
    await new Promise((r) => setTimeout(r, graceMs))
    for (const id of ids) {
      const ls = this.live.get(id)
      if (ls) {
        try {
          ls.proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
      }
    }
  }
}

export const sessionManager = new SessionManager()
