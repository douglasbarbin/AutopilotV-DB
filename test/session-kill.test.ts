/**
 * Kill must actually kill — including the failure modes where it historically
 * didn't: sessions with no live PTY (failed launches) silently no-op'd and
 * wedged in an active status, and TERM-ignoring processes were never escalated
 * to SIGKILL.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  safeStorage: undefined
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { sessionManager } from '../src/main/sessions/manager'
import type { HarnessConfig } from '../src/shared/types/domain'

function harness(command: string, args: string[]): HarnessConfig {
  return {
    id: 'test-harness',
    displayName: 'Test',
    enabled: true,
    isReviewDefault: false,
    isBrainDefault: false,
    isCodingDefault: false,
    launch: { command, args },
    stall: { idleSeconds: 45, waitingPatterns: [] },
    inject: { method: 'stdin', submitKey: '\r' }
  }
}

const until = async (cond: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  return cond()
}

describe('sessionManager.kill', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(async () => {
    await sessionManager.killAll('test cleanup')
    closeDb()
  })

  it('kills the bookkeeping even when there is no live process (orphan/failed launch)', () => {
    const id = store.createSession({
      kind: 'dev',
      workRef: 'dev:1',
      harnessId: 'test-harness',
      worktreeId: null,
      title: 'orphan'
    })
    store.setSessionStatus(id, 'running')

    sessionManager.kill(id, 'user clicked kill')

    const s = store.getSession(id)!
    expect(s.status).toBe('killed')
    expect(s.exitReason).toContain('no live process')
  })

  // POSIX-only: needs /bin/sh and trap/SIGTERM semantics that don't exist on Windows.
  it.skipIf(process.platform === 'win32')('escalates to SIGKILL for processes that ignore SIGTERM/SIGHUP', async () => {
    const id = sessionManager.spawn({
      kind: 'dev',
      workRef: 'dev:2',
      harness: harness('/bin/sh', ['-c', "trap '' TERM HUP; sleep 60"]),
      cwd: tmpdir(),
      env: process.env,
      worktreeId: null,
      title: 'stubborn'
    })
    // Give the trap a beat to install.
    await new Promise((r) => setTimeout(r, 500))
    expect(sessionManager.isLive(id)).toBe(true)

    sessionManager.kill(id, 'test')

    // SIGTERM is ignored; the 2.5s escalation must SIGKILL it.
    expect(await until(() => !sessionManager.isLive(id), 8000)).toBe(true)
    expect(store.getSession(id)!.status).toBe('killed')
  }, 15_000)

  it('a harness that fails to launch is marked dead immediately, not stuck active', async () => {
    const id = sessionManager.spawn({
      kind: 'dev',
      workRef: 'dev:3',
      harness: harness('/nonexistent-binary-autopilotv-test', []),
      cwd: tmpdir(),
      env: process.env,
      worktreeId: null,
      title: 'no such binary'
    })

    const settled = await until(() => {
      const s = store.getSession(id)!
      return s.status === 'killed' || s.status === 'exited'
    }, 5000)
    expect(settled).toBe(true)
    // Either way, a plain kill click afterwards must not wedge.
    sessionManager.kill(id, 'post-failure kill')
    expect(['killed', 'exited']).toContain(store.getSession(id)!.status)
  }, 10_000)
})
