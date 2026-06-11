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

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import * as forges from '../src/main/forges'
import { sessionManager } from '../src/main/sessions/manager'
import { ADVANCE_FNS } from '../src/main/dev/phases'

// Mutable PR readiness our spied forge returns. Sticky changes-requested with
// zero unresolved threads — exactly the loop the user hit. We spy on
// forgeForRepo (and restore it in afterEach) rather than vi.mock the whole
// module, so this file can't leak its forge into other test files when the
// runner shares the module registry (e.g. CI without per-file isolation).
let readiness = {
  state: 'OPEN' as const,
  mergeable: false,
  statusOk: false,
  approvals: 0,
  changesRequested: true,
  unresolvedThreads: 0
}

function git(cwd: string, ...args: string[]): void {
  exec('git', args, { cwd, stdio: 'ignore' })
}

describe('address-comments loop prevention', () => {
  let repoDir: string
  let spawnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    readiness = {
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
    // Spy (not module mock) so nothing leaks into other files: a forge that
    // only needs getPrReadiness for the review babysit path, and a no-op spawn.
    vi.spyOn(forges, 'forgeForRepo').mockReturnValue({
      forge: { getPrReadiness: async () => readiness },
      config: {}
    } as unknown as ReturnType<typeof forges.forgeForRepo>)
    spawnSpy = vi.spyOn(sessionManager, 'spawn').mockReturnValue(999)
  })
  afterEach(() => {
    vi.restoreAllMocks()
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

  it('re-addresses when an additional comment arrives on the same commit', async () => {
    const id = seedReviewTask()
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    // Same sticky state, same commit → no respawn.
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)

    // Reviewer leaves an additional comment (a new unresolved thread) on the
    // SAME commit → one fresh round.
    readiness = { ...readiness, unresolvedThreads: 1 }
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(2)

    // No further new comments → it waits again.
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(2)
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

  it('does not spawn at all when there is no feedback and the PR is mergeable', async () => {
    const id = seedReviewTask()
    // statusOk stays false so the gates are unsatisfied without any feedback;
    // mergeable so the conflict-dispatch path stays quiet too.
    readiness = { ...readiness, changesRequested: false, unresolvedThreads: 0, mergeable: true }
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('dispatches ONE conflict-resolution session when the PR is not mergeable', async () => {
    const id = seedReviewTask()
    readiness = { ...readiness, changesRequested: false, unresolvedThreads: 0, mergeable: false }

    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)
    const opts = spawnSpy.mock.calls[0][0] as { initialInput?: string; title: string }
    expect(opts.title).toContain('resolve conflicts')
    expect(opts.initialInput).toContain('NOT MERGEABLE')

    // Same head commit → the once-per-sha guard holds (no session spam).
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(1)

    // A new commit (e.g. the pushed merge) re-arms exactly one more attempt.
    wf(join(repoDir, 'a.txt'), 'two')
    git(repoDir, 'commit', '-qam', 'merge main')
    await ADVANCE_FNS.in_review(store.getTask(id)!, store.getSettings())
    expect(spawnSpy).toHaveBeenCalledTimes(2)
  })
})
