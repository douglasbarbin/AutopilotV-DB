/**
 * Regression: a sticky "changes requested" review (state stays true until the
 * reviewer re-reviews, even with every thread resolved) must NOT cause the
 * brain to re-spawn an address-comments session every tick. We address the
 * feedback once per PR head commit, record it (addressed_sha), then wait.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync as exec } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync as wf } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

// Mutable PR readiness the mocked forge returns. Sticky changes-requested with
// zero unresolved threads — exactly the loop the user hit.
const h = vi.hoisted(() => ({
  readiness: {
    state: 'OPEN' as const,
    mergeable: false,
    statusOk: false,
    approvals: 0,
    changesRequested: true,
    unresolvedThreads: 0
  }
}))

vi.mock('../src/main/forges', () => ({
  forgeForRepo: () => ({ forge: { getPrReadiness: async () => h.readiness }, config: {} })
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { sessionManager } from '../src/main/sessions/manager'
import { ADVANCE_FNS } from '../src/main/dev/phases'

function git(cwd: string, ...args: string[]): void {
  exec('git', args, { cwd, stdio: 'ignore' })
}

describe('address-comments loop prevention', () => {
  let repoDir: string
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    h.readiness = {
      state: 'OPEN',
      mergeable: false,
      statusOk: false,
      approvals: 0,
      changesRequested: true,
      unresolvedThreads: 0
    }
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    repoDir = mkdtempSync(join(tmpdir(), 'apv-addr-'))
    git(repoDir, 'init', '-q')
    git(repoDir, 'config', 'user.email', 't@t.test')
    git(repoDir, 'config', 'user.name', 'Test')
    wf(join(repoDir, 'a.txt'), 'one')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-qm', 'first')
    // Spy on spawn so no real PTY launches; return a fake (dead) session id.
    spawnSpy = vi.spyOn(sessionManager, 'spawn').mockReturnValue(999)
  })
  afterEach(() => {
    spawnSpy.mockRestore()
    closeDb()
    rmSync(repoDir, { recursive: true, force: true })
  })

  function seedReviewTask(): number {
    const repo = store.upsertRepo({
      name: 'owner/repo',
      remote: 'https://example.com/owner/repo.git',
      defaultBranch: 'main',
      path: repoDir,
      forge: 'github'
    })
    const wt = store.createWorktree({ path: repoDir, repoId: repo.id, branch: 'feature', kind: 'dev', sessionId: null })
    const { id } = store.upsertTask({ issueKey: 'T-1', title: 'task', projectKey: 'T' })
    store.setTaskRepo(id, repo.id)
    store.setTaskWorktree(id, wt)
    store.setTaskPr(id, 7, 'https://example.com/pr/7')
    store.setTaskPhase(id, 'in_review')
    return id
  }

  it('addresses feedback once, then stops while changes-requested stays sticky', async () => {
    const id = seedReviewTask()
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const addressed = store.getTask(id)!.addressedSha
    expect(addressed).not.toBe('')

    // Several more ticks with the SAME sticky state + same commit → no respawn.
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)
  })

  it('addresses again once the PR head advances (new commit)', async () => {
    const id = seedReviewTask()
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)

    // A new commit on the branch (e.g. reviewer pushed) → one fresh round.
    wf(join(repoDir, 'a.txt'), 'two')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-qm', 'second')
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(2)
  })

  it('does not spawn at all when there is no feedback', async () => {
    const id = seedReviewTask()
    h.readiness = { ...h.readiness, changesRequested: false, unresolvedThreads: 0 }
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).not.toHaveBeenCalled()
  })
})
