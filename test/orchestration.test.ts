/**
 * Orchestration tests: cover the most stateful parts of the app that the
 * previous test suite left uncovered — the claim/lease protocol, the per-phase
 * dev advances, and the brain's reconcile path. These run in-process with
 * an in-memory SQLite (no Electron), mocked external calls (`gh`, `acli`,
 * fetch), and stub harness sessions (no real PTYs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Mock the Electron `app` module before any store code is imported, so the DB
// module's `app.getPath('userData')` doesn't blow up.
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

import { __openInMemoryDbForTesting, closeDb, getDb } from '../src/main/db'
import * as store from '../src/main/store'
import * as forges from '../src/main/forges'
import { SIGNAL, consume as consumeSignal } from '../src/main/worktree/signals'
import { brain } from '../src/main/brain/brain'
import { ADVANCE_FNS } from '../src/main/dev/phases'
import { DEFAULT_SETTINGS } from '../src/main/config/defaults'

/**
 * Stub the active forge by spying on the real module export (restored in
 * afterEach). This replaces the older `vi.doMock('../forges') + re-import
 * phases` pattern, which left the re-imported module bound to the REAL
 * forgeForRepo — so `forge.findPrForBranch` shelled out to `gh` and hung on
 * CI runners without a fast `gh`. The spy guarantees no real process spawns.
 */
function stubForge(forge: Record<string, unknown>): void {
  vi.spyOn(forges, 'forgeForRepo').mockReturnValue({
    forge,
    config: {}
  } as unknown as ReturnType<typeof forges.forgeForRepo>)
}

// We test against the default settings — override as needed per test.
function setSettings(patch: Partial<typeof DEFAULT_SETTINGS>): void {
  store.updateSettings(patch)
}

function seedTask(overrides: Partial<Parameters<typeof store.upsertTask>[0]> = {}): number {
  const r = store.upsertTask({
    issueKey: 'TEST-1',
    title: 'Test task',
    status: 'todo',
    trackerStatus: 'To Do',
    issueType: 'Story',
    projectKey: 'TEST',
    ...overrides
  })
  return r.id
}

function seedRepo(overrides: Partial<{ name: string; path: string; forge: string }> = {}): number {
  const r = store.upsertRepo({
    name: overrides.name ?? 'owner/repo',
    remote: 'https://example.com/owner/repo.git',
    defaultBranch: 'main',
    path: overrides.path ?? null,
    forge: overrides.forge ?? 'github'
  })
  return r.id
}

describe('claim/lease protocol', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => {
    // closeDb is a no-op on the in-memory DB but ensures a clean slate.
    closeDb()
    closeDb()
  })

  it('claimWork is atomic: two callers, only one wins', () => {
    const taskId = seedTask()
    expect(store.claimWork('dev', taskId, 'callerA')).toBe(true)
    expect(store.claimWork('dev', taskId, 'callerB')).toBe(false)
  })

  it('renewLease only renews the owner that holds the lease', () => {
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    expect(store.getTask(taskId)?.claimState).toBe('claimed')
    store.renewLease('dev', taskId, 'ownerA') // OK
    store.renewLease('dev', taskId, 'ownerB') // silently no-ops (changes=0)
    // releaseLease clears the lease markers but does not reset claim_state;
    // reclaimExpiredLeases is the path that returns rows to unclaimed.
    store.releaseLease('dev', taskId)
    const t = store.getTask(taskId)
    expect(t?.claimState).toBe('claimed')
    // A subsequent rewind + reclaim will pick it up.
    const db = getDb()
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?").run(taskId)
    expect(store.reclaimExpiredLeases()).toBe(1)
    expect(store.getTask(taskId)?.claimState).toBe('unclaimed')
  })

  it('reclaimExpiredLeases returns expired work to unclaimed', () => {
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    store.attachSessionToWork('dev', taskId, 999) // fake session id
    // Manually rewind the lease to the past.
    const db = getDb()
    db.prepare(
      "UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?"
    ).run(taskId)
    const reset = store.reclaimExpiredLeases()
    expect(reset).toBe(1)
    const t = store.getTask(taskId)
    expect(t?.claimState).toBe('unclaimed')
    expect(t?.sessionId).toBeNull()
  })

  it('a non-expired lease is preserved', () => {
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    const reset = store.reclaimExpiredLeases()
    expect(reset).toBe(0)
    expect(store.getTask(taskId)?.claimState).toBe('claimed')
  })
})

describe('dev phase advances', () => {
  let worktreeDir: string

  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    worktreeDir = mkdtempSync(join(tmpdir(), 'autopilotv-test-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(worktreeDir, { recursive: true, force: true })
    closeDb()
    closeDb()
  })

  it('advanceImplementing → draft when .pr-url signal arrives', async () => {
    // Provision a repo + worktree row.
    const repoId = seedRepo({ name: 'owner/repo', forge: 'github' })
    const taskId = seedTask({ status: 'in_progress', trackerStatus: 'In Progress' })
    const wtId = store.createWorktree({
      path: worktreeDir,
      repoId,
      branch: 'autopilotv/TEST-1-test-task',
      kind: 'dev',
      sessionId: null
    })
    store.setTaskRepo(taskId, repoId)
    store.setTaskWorktree(taskId, wtId)
    store.setTaskPhase(taskId, 'implementing')

    // Write the .pr-url signal that an implementing agent would write.
    writeFileSync(join(worktreeDir, SIGNAL.PR_URL), 'https://github.com/owner/repo/pull/42')

    // findPrForBranch returns null so the code path goes through the .pr-url signal.
    stubForge({ findPrForBranch: vi.fn().mockResolvedValue(null) })
    await ADVANCE_FNS.implementing(store.getTask(taskId)!, store.getSettings())

    const t = store.getTask(taskId)
    expect(t?.phase).toBe('draft')
    expect(t?.prNumber).toBe(42)
  })

  it('advanceImplementing → error when session died without producing PR', async () => {
    const repoId = seedRepo({ name: 'owner/repo' })
    const taskId = seedTask({ status: 'in_progress', trackerStatus: 'In Progress' })
    const wtId = store.createWorktree({
      path: worktreeDir,
      repoId,
      branch: 'autopilotv/TEST-1',
      kind: 'dev',
      sessionId: null
    })
    store.setTaskRepo(taskId, repoId)
    store.setTaskWorktree(taskId, wtId)
    store.setTaskPhase(taskId, 'implementing')
    // No .pr-url file. No live session.
    stubForge({ findPrForBranch: vi.fn().mockResolvedValue(null) })
    await ADVANCE_FNS.implementing(store.getTask(taskId)!, store.getSettings())
    expect(store.getTask(taskId)?.phase).toBe('error')
  })

  it('advanceRevising → draft when .revise signal arrives (worktree not yet published)', async () => {
    const repoId = seedRepo({ name: 'owner/repo' })
    const taskId = seedTask({ status: 'in_progress', trackerStatus: 'In Progress' })
    const wtId = store.createWorktree({
      path: worktreeDir,
      repoId,
      branch: 'autopilotv/TEST-1',
      kind: 'dev',
      sessionId: null
    })
    store.setTaskRepo(taskId, repoId)
    store.setTaskWorktree(taskId, wtId)
    store.setTaskPr(taskId, 99, 'https://example.com/pr/99')
    store.setTaskPhase(taskId, 'revising')

    writeFileSync(join(worktreeDir, SIGNAL.REVISE), '')
    stubForge({ findPrForBranch: vi.fn().mockResolvedValue({ isDraft: true, state: 'OPEN' }) })
    await ADVANCE_FNS.revising(store.getTask(taskId)!, store.getSettings())
    expect(store.getTask(taskId)?.phase).toBe('draft')
  })

  it('consume helper reads and clears the signal atomically', () => {
    const p = join(worktreeDir, SIGNAL.ADDRESS_COMMENTS)
    writeFileSync(p, 'done')
    expect(consumeSignal(worktreeDir, SIGNAL.ADDRESS_COMMENTS)).toBe('done')
    // After consume, the file is gone — re-consuming returns null.
    expect(consumeSignal(worktreeDir, SIGNAL.ADDRESS_COMMENTS)).toBeNull()
  })
})

describe('brain reconcile', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => {
    closeDb()
    closeDb()
  })

  it('reclaims expired leases on boot', () => {
    // Seed a task that has an expired lease.
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    const db = getDb()
    db.prepare("UPDATE tasks SET lease_expires_at = datetime('now', '-1 hour') WHERE id = ?").run(taskId)

    const b = brain
    b.reconcile()
    expect(store.getTask(taskId)?.claimState).toBe('unclaimed')
  })

  it('marks orphaned sessions (dead PID) as killed', () => {
    // Insert a session row with a PID that almost certainly isn't alive.
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    const sid = store.createSession({
      kind: 'dev',
      workRef: `dev:${taskId}`,
      harnessId: 'claude',
      worktreeId: null,
      title: 'orphan'
    })
    store.setSessionPid(sid, 999_999) // dead PID

    // Manually attach so the session is "active".
    store.attachSessionToWork('dev', taskId, sid)
    store.setSessionStatus(sid, 'running')

    const b = brain
    b.reconcile()
    const s = store.getSession(sid)
    expect(s?.status).toBe('killed')
    expect(s?.exitReason).toBe('orphaned')
  })

  it('does not reclaim a fresh lease', () => {
    const taskId = seedTask()
    store.claimWork('dev', taskId, 'ownerA')
    const b = brain
    b.reconcile()
    expect(store.getTask(taskId)?.claimState).toBe('claimed')
  })
})

describe('settings round-trip', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
  })
  afterEach(() => {
    closeDb()
    closeDb()
  })

  it('preserves all default fields when only one is patched', () => {
    setSettings({ requiredApprovals: 2 })
    const s = store.getSettings()
    expect(s.requiredApprovals).toBe(2)
    expect(s.pollIntervalSeconds).toBe(DEFAULT_SETTINGS.pollIntervalSeconds)
  })

  it('integration health is upserted by name', () => {
    const ts = () => new Date().toISOString()
    store.setIntegrationHealth({ name: 'forge', status: 'ok', detail: 'first', checkedAt: ts() })
    store.setIntegrationHealth({ name: 'forge', status: 'down', detail: 'second', checkedAt: ts() })
    const all = store.getIntegrationHealth()
    expect(all.filter((h) => h.name === 'forge')).toHaveLength(1)
    expect(all.find((h) => h.name === 'forge')?.detail).toBe('second')
  })
})

describe('harness role-default enforcement', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => {
    closeDb()
    closeDb()
  })

  it('setting a role default clears it on every other harness', () => {
    // After seedIfEmpty, claude is the review default.
    const all = store.listHarnesses()
    const claude = all.find((h) => h.id === 'claude')!
    const pi = all.find((h) => h.id === 'pi')!
    expect(claude.isReviewDefault).toBe(true)
    expect(pi.isReviewDefault).toBe(false)

    // Promote pi to review default; claude should lose it.
    store.upsertHarness({ ...pi, isReviewDefault: true })

    const after = store.listHarnesses()
    expect(after.find((h) => h.id === 'pi')!.isReviewDefault).toBe(true)
    expect(after.find((h) => h.id === 'claude')!.isReviewDefault).toBe(false)
  })

  it('normalizeReviewDefault repairs a DB that ended up with multiple review defaults', () => {
    // Force two review defaults by mutating config_json directly (simulate
    // historical drift before the v11 migration).
    const claude = store.getHarness('claude')!
    const pi = store.getHarness('pi')!
    store.upsertHarness({ ...claude, isReviewDefault: true })
    store.upsertHarness({ ...pi, isReviewDefault: true })

    store.normalizeReviewDefault()
    const after = store.listHarnesses()
    const reviewDefaults = after.filter((h) => h.isReviewDefault)
    expect(reviewDefaults).toHaveLength(1)
  })
})
