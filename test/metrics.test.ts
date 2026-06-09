/**
 * Cost/quality scorecards (theme D): seed sessions / events / reviews /
 * verifications, then assert computeMetrics aggregates them correctly.
 * Time / rework / outcome only — no token data.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { computeMetrics } from '../src/main/metrics/scorecard'

describe('computeMetrics', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => closeDb())

  it('aggregates harness sessions, dev throughput, verifications and reviews', () => {
    // Two dev sessions + one review session under the seeded 'claude' harness.
    const dev1 = store.createSession({ kind: 'dev', workRef: 'dev:1', harnessId: 'claude', worktreeId: null, title: 'd1' })
    const dev2 = store.createSession({ kind: 'dev', workRef: 'dev:2', harnessId: 'claude', worktreeId: null, title: 'd2' })
    store.setSessionStatus(dev1, 'exited', 'done')
    store.setSessionStatus(dev2, 'needs_human', 'stuck')

    // A merged dev task + a reset, plus pass/fail command verifications.
    store.recordEvent('dev.merged', { taskId: 1, prNumber: 11 })
    store.recordEvent('dev.changes_requested', { taskId: 1, prNumber: 11 })
    store.recordEvent('dev.reset', { taskId: 2 })
    store.insertVerification({ taskId: 1, prNumber: 11, commitSha: 'aaa', kind: 'command', status: 'pass', summary: 'ok' })
    store.insertVerification({ taskId: 2, prNumber: 22, commitSha: 'bbb', kind: 'command', status: 'fail', summary: 'bad' })

    // A captured + acted-on review under 'claude'.
    const repo = store.upsertRepo({ name: 'owner/repo', remote: 'r', path: null, forge: 'github' })
    const { review: pr } = store.upsertPrReview({
      prNumber: 9,
      repoId: repo.id,
      title: 'PR',
      author: 'someone',
      branch: 'b',
      url: 'u'
    })
    const rev = store.createSession({ kind: 'review', workRef: `review:${pr.id}`, harnessId: 'claude', worktreeId: null, title: 'rev' })
    store.setSessionStatus(rev, 'exited', 'done')
    store.attachSessionToWork('review', pr.id, rev)
    const reviewId = store.insertReview({ prReviewId: pr.id, recommendation: 'approve', summary: 's', findings: [] })
    store.recordReviewAction(reviewId, 'approve')

    const m = computeMetrics()

    const claude = m.harnesses.find((h) => h.harnessId === 'claude')!
    expect(claude.sessionsTotal).toBe(3)
    expect(claude.sessionsDev).toBe(2)
    expect(claude.sessionsReview).toBe(1)
    expect(claude.endedNeedsHuman).toBe(1)
    expect(claude.reviewsCaptured).toBe(1)
    expect(claude.reviewRecommendations.approve).toBe(1)

    expect(m.dev.tasksMerged).toBe(1)
    expect(m.dev.resets).toBe(1)
    expect(m.dev.verificationPassRate).toBeCloseTo(0.5)
    // task 1 merged with one changes-requested round.
    expect(m.dev.avgReworkCycles).toBeCloseTo(1)

    expect(m.review.completed).toBe(1)
    expect(m.review.recommendations.approve).toBe(1)
    expect(m.review.humanApproveRate).toBeCloseTo(1)
  })

  it('returns null rates and empty harness list on a fresh database', () => {
    const m = computeMetrics()
    expect(m.dev.tasksMerged).toBe(0)
    expect(m.dev.verificationPassRate).toBeNull()
    expect(m.review.humanApproveRate).toBeNull()
    expect(m.harnesses).toEqual([])
  })
})
