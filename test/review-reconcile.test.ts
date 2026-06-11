/**
 * Review-lane reconciliation: a queued/in-flight pr_review whose PR merged or
 * closed externally must be superseded (no branch left to review), while a
 * merely-withdrawn review request (PR still open) and repos whose discovery
 * errored this tick are left alone.
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
import * as forges from '../src/main/forges'
import { reconcileExternallyResolvedReviews } from '../src/main/review/orchestrator'

function stubForge(forge: Record<string, unknown>): void {
  vi.spyOn(forges, 'forgeForRepo').mockReturnValue({
    forge,
    config: {}
  } as unknown as ReturnType<typeof forges.forgeForRepo>)
}

function seedRepo(name = 'owner/repo'): number {
  return store.upsertRepo({
    name,
    remote: `https://example.com/${name}.git`,
    defaultBranch: 'main',
    path: null,
    forge: 'github'
  }).id
}

function seedPrReview(repoId: number, prNumber: number): number {
  const { review } = store.upsertPrReview({
    prNumber,
    repoId,
    title: `PR ${prNumber}`,
    author: 'alice',
    branch: 'feature',
    url: `https://example.com/pull/${prNumber}`
  })
  return review.id
}

describe('reconcileExternallyResolvedReviews', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    closeDb()
  })

  it('supersedes a review whose PR merged externally', async () => {
    const repoId = seedRepo()
    const id = seedPrReview(repoId, 7)
    stubForge({
      getAdoptablePr: vi.fn().mockResolvedValue({ number: 7, state: 'MERGED', url: '', branch: 'feature', isDraft: false, title: 'PR 7' })
    })

    const superseded = await reconcileExternallyResolvedReviews(new Set(), new Set())

    expect(superseded).toEqual([{ prNumber: 7, title: 'PR 7', reason: 'merged externally' }])
    const pr = store.getPrReview(id)!
    expect(pr.state).toBe('superseded')
    expect(pr.claimState).toBe('done')
  })

  it('supersedes a review whose PR no longer exists', async () => {
    const repoId = seedRepo()
    const id = seedPrReview(repoId, 8)
    stubForge({ getAdoptablePr: vi.fn().mockResolvedValue(null) })

    const superseded = await reconcileExternallyResolvedReviews(new Set(), new Set())

    expect(superseded[0]?.reason).toBe('PR no longer exists')
    expect(store.getPrReview(id)!.state).toBe('superseded')
  })

  it('leaves an OPEN PR alone even when absent from the requested set', async () => {
    const repoId = seedRepo()
    const id = seedPrReview(repoId, 9)
    stubForge({
      getAdoptablePr: vi.fn().mockResolvedValue({ number: 9, state: 'OPEN', url: '', branch: 'feature', isDraft: false, title: 'PR 9' })
    })

    const superseded = await reconcileExternallyResolvedReviews(new Set(), new Set())

    expect(superseded).toEqual([])
    expect(store.getPrReview(id)!.state).toBe('discovered')
  })

  it('skips PRs still in the review-requested set without a forge call', async () => {
    const repoId = seedRepo()
    seedPrReview(repoId, 10)
    const getAdoptablePr = vi.fn()
    stubForge({ getAdoptablePr })

    await reconcileExternallyResolvedReviews(new Set([`${repoId}:10`]), new Set())

    expect(getAdoptablePr).not.toHaveBeenCalled()
  })

  it('skips repos whose discovery errored this tick', async () => {
    const repoId = seedRepo('owner/flaky')
    const id = seedPrReview(repoId, 11)
    const getAdoptablePr = vi.fn().mockResolvedValue({ number: 11, state: 'MERGED' })
    stubForge({ getAdoptablePr })

    await reconcileExternallyResolvedReviews(new Set(), new Set(['owner/flaky']))

    expect(getAdoptablePr).not.toHaveBeenCalled()
    expect(store.getPrReview(id)!.state).toBe('discovered')
  })

  it('leaves the review untouched when the forge lookup throws', async () => {
    const repoId = seedRepo()
    const id = seedPrReview(repoId, 12)
    stubForge({ getAdoptablePr: vi.fn().mockRejectedValue(new Error('network')) })

    const superseded = await reconcileExternallyResolvedReviews(new Set(), new Set())

    expect(superseded).toEqual([])
    expect(store.getPrReview(id)!.state).toBe('discovered')
  })

  it('ignores reviews already in a terminal state', async () => {
    const repoId = seedRepo()
    const id = seedPrReview(repoId, 13)
    store.setPrReviewState(id, 'submitted')
    const getAdoptablePr = vi.fn()
    stubForge({ getAdoptablePr })

    await reconcileExternallyResolvedReviews(new Set(), new Set())

    expect(getAdoptablePr).not.toHaveBeenCalled()
    expect(store.getPrReview(id)!.state).toBe('submitted')
  })
})
