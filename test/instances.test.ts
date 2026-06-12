/**
 * App instance manager: detached-launcher semantics (e.g. `aspire start`,
 * `docker compose up -d`) — a clean launcher exit is the success path, the
 * ready probe decides, and teardown still runs after the launcher is gone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  safeStorage: undefined
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { appInstances, allocatePort } from '../src/main/apps/instances'
import { RunbookSchema } from '../src/main/runbook/runbook'
import type { Repo } from '../src/shared/types/domain'

let dir: string

function repoStub(): Repo {
  const r = store.upsertRepo({
    name: 'owner/app',
    remote: 'https://example.com/owner/app.git',
    defaultBranch: 'main',
    path: dir,
    forge: 'github'
  })
  return r
}

function appSlot(yaml: Record<string, unknown>) {
  return RunbookSchema.parse({ app: yaml }).app!
}

describe('appInstances (detached launchers)', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    dir = mkdtempSync(join(tmpdir(), 'instances-'))
  })
  afterEach(async () => {
    await appInstances.stopAll('test cleanup')
    rmSync(dir, { recursive: true, force: true })
    closeDb()
  })

  // POSIX-only: the teardown uses `touch` and the run line uses sh `;` chaining.
  it.skipIf(process.platform === 'win32')('a detached launcher that prints its ready line and exits 0 is ready; teardown still runs', async () => {
    const repo = repoStub()
    const app = appSlot({
      run: 'echo "Dashboard: https://localhost:18999/login?t=x"; exit 0',
      detached: true,
      ready: { logPattern: 'Dashboard', timeoutSeconds: 20 },
      teardown: 'touch {worktree}/torn-down'
    })
    const r = await appInstances.start(repo, dir, app, null)
    expect(r.ok).toBe(true)
    expect(r.summary).toContain('log pattern')

    await appInstances.stop(r.instance!.id, 'test')
    expect(existsSync(join(dir, 'torn-down'))).toBe(true)
  })

  it('a detached launcher exiting non-zero fails readiness', async () => {
    const repo = repoStub()
    const app = appSlot({
      run: 'echo starting; exit 9',
      detached: true,
      ready: { logPattern: 'NEVER-PRINTED', timeoutSeconds: 4 }
    })
    const r = await appInstances.start(repo, dir, app, null)
    expect(r.ok).toBe(false)
  }, 15_000)

  it('a non-detached app exiting before ready fails (unchanged semantics)', async () => {
    const repo = repoStub()
    const app = appSlot({ run: 'exit 0', ready: { logPattern: 'NOPE', timeoutSeconds: 4 } })
    const r = await appInstances.start(repo, dir, app, null)
    expect(r.ok).toBe(false)
    expect(r.summary).toContain('exited')
  }, 15_000)

  it('allocatePort returns a usable free port', async () => {
    const p = await allocatePort()
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(65536)
  })
})
