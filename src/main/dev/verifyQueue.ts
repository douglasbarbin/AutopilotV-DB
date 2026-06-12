import { log } from '../log'

/**
 * Background runner for verification work.
 *
 * Pipelines (setup → build → test → app → e2e) can run for many minutes.
 * They used to be awaited inside the brain tick, which froze every other
 * lifecycle step — review harvesting, session auto-drive, scheduling — until
 * the pipeline finished. Now the tick ENQUEUES a job here and moves on; the
 * verdict is persisted as task_verifications rows, and a later tick consumes
 * it through the normal verdict-by-SHA cache.
 *
 * Concurrency is deliberately 1: pipelines contend for ports, build dirs and
 * CPU, and the single activeVerification UI slot assumes one live pipeline.
 * This matches the old sequential behavior — minus the frozen tick.
 *
 * Jobs are keyed (`verify:<taskId>:<checkpoint>:<sha>`) so a tick that fires
 * while a job is queued or running never double-enqueues the same work.
 */

const queued: { key: string; run: () => Promise<void> }[] = []
const pending = new Set<string>()
let activeKey: string | null = null

/** True while a job with this key is queued or running. */
export function isVerificationPending(key: string): boolean {
  return pending.has(key)
}

/** Enqueue a verification job; no-op if the key is already queued/running. */
export function enqueueVerification(key: string, run: () => Promise<void>): void {
  if (pending.has(key)) return
  pending.add(key)
  queued.push({ key, run })
  void drain()
}

/** Test helper / shutdown hook: resolves once the queue is fully idle. */
export async function waitForVerificationQueue(): Promise<void> {
  while (activeKey !== null || queued.length > 0) {
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function drain(): Promise<void> {
  if (activeKey !== null) return
  const next = queued.shift()
  if (!next) return
  activeKey = next.key
  try {
    await next.run()
  } catch (err) {
    log.warn('verification job failed', { key: next.key, err: String(err) })
  } finally {
    pending.delete(next.key)
    activeKey = null
    // Surface the new verdict rows without waiting for the next tick. Lazy
    // import: state → brain → … → phases → verifyQueue would otherwise cycle.
    try {
      const { pushState } = await import('../state')
      pushState()
    } catch {
      /* state module unavailable (unit tests) */
    }
    void drain()
  }
}
