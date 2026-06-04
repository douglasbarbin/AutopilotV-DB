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

interface LiveSession {
  id: number
  proc: pty.IPty
  seq: number
  ring: string // bounded tail buffer
  transcript: WriteStream
  transcriptPath: string
  harness: HarnessConfig
}

const RING_MAX = 64 * 1024

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

    const proc = pty.spawn(opts.harness.launch.command, args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: opts.cwd,
      env: {
        ...opts.env,
        // Advertise full 24-bit truecolor support so tools like bat, delta,
        // lazygit, rich, etc. render with their full color output without
        // needing any extra user configuration.
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        ...lmEnv,
        ...(opts.harness.launch.env ?? {})
      } as { [k: string]: string }
    })

    const transcriptPath = join(this.transcriptsDir, `session-${sessionId}.log`)
    const transcript = createWriteStream(transcriptPath, { flags: 'a' })

    const ls: LiveSession = {
      id: sessionId,
      proc,
      seq: 0,
      ring: '',
      transcript,
      transcriptPath,
      harness: opts.harness
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
      // Type the prompt once the harness UI is up, then send a SEPARATE submit
      // keypress to kick off the task — interactive TUIs (Pi, Claude, …) don't
      // run on the text alone; they need a discrete Enter after it.
      const text = opts.initialInput.replace(/[\r\n]+$/, '')
      const submit = opts.harness.inject.submitKey || '\r'
      setTimeout(() => {
        this.write(sessionId, text)
        setTimeout(() => {
          this.write(sessionId, submit)
          store.recordEvent('session.kickoff', { via: 'initial-input' }, { sessionId })
        }, 1000) // 1 second delay after typing to ensure the terminal registers the command text
      }, 3000) // Wait 3 seconds for harness command-line to fully spin up
    }

    return sessionId
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
    if (!ls) return
    store.setSessionStatus(sessionId, 'killed', reason)
    store.recordEvent('session.killed', { reason }, { sessionId })
    this.emit('status', sessionId, 'killed')
    try {
      ls.proc.kill()
    } catch {
      /* already gone */
    }
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
