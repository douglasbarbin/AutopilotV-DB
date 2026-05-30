import { spawn, type ChildProcess } from 'child_process'
import { log } from '../log'
import type { LocalModelConfig } from '@shared/types/domain'

interface ManagedProc {
  proc: ChildProcess
  endpoint: string
}

const managed = new Map<string, ManagedProc>()

/** Poll an OpenAI-compatible endpoint to see if it is already serving — never starts anything. */
export async function pingEndpoint(
  endpoint: string,
  path = '/v1/models',
  timeoutMs = 3000
): Promise<boolean> {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const resp = await fetch(`${endpoint}${path}`, { signal: ac.signal })
    clearTimeout(t)
    return resp.ok
  } catch {
    return false
  }
}

export function healthCheck(cfg: LocalModelConfig): Promise<boolean> {
  return pingEndpoint(cfg.endpoint, cfg.health?.path ?? '/v1/models', cfg.health?.timeoutMs ?? 3000)
}

/** Start the local model server if configured and not already healthy. */
export async function ensureLocalModel(harnessId: string, cfg: LocalModelConfig): Promise<boolean> {
  if (await healthCheck(cfg)) return true
  if (!cfg.start) {
    log.warn('local model down and no managed start configured', { harnessId })
    return false
  }
  if (managed.has(harnessId)) return false // already starting

  log.info('starting managed local model', { harnessId, cmd: cfg.start.command })
  const proc = spawn(cfg.start.command, cfg.start.args, {
    detached: false,
    stdio: 'ignore'
  })
  managed.set(harnessId, { proc, endpoint: cfg.endpoint })
  proc.on('exit', () => managed.delete(harnessId))

  // poll for readiness up to ~15s
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000))
    if (await healthCheck(cfg)) return true
  }
  return false
}

export function stopLocalModel(harnessId: string): void {
  const m = managed.get(harnessId)
  if (m) {
    try {
      m.proc.kill()
    } catch {
      /* ignore */
    }
    managed.delete(harnessId)
  }
}

export function stopAll(): void {
  for (const id of [...managed.keys()]) stopLocalModel(id)
}
