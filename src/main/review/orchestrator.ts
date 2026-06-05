import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { provisionReviewWorktree, pruneWorktree, resolveRealGit } from '../worktree/manager'
import { buildReviewSandbox } from '../worktree/sandbox'
import { forgeForRepo } from '../forges'
import { notifier } from '../notify'
import { ReviewResultSchema } from '../llm/provider'
import type { PrReview, ReviewAction } from '@shared/types/domain'

const REVIEW_FILE = '.review.json'

/**
 * Begin reviewing a PR: provision an isolated, sandboxed worktree and spawn the
 * review harness. The session writes TASKMAN_REVIEW.json which is harvested on a
 * later tick. Returns the session id, or null if it could not start.
 */
export async function startReview(pr: PrReview): Promise<number | null> {
  const repo = store.getRepo(pr.repoId)
  const harness = store.getReviewHarness()
  if (!repo || !repo.path) {
    store.setPrReviewState(pr.id, 'error')
    store.recordEvent('review.no_repo', { prReviewId: pr.id }, { level: 'warn' })
    return null
  }
  if (!harness) {
    store.setPrReviewState(pr.id, 'error')
    store.recordEvent('review.no_harness', { prReviewId: pr.id }, { level: 'warn' })
    return null
  }

  // Resolve branch if we don't have it yet.
  let branch = pr.branch
  if (!branch) {
    try {
      const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())
      const full = await forge.getPr(repo.name, pr.prNumber, forgeConfig)
      branch = full.headRefName
      store.upsertPrReview({
        prNumber: pr.prNumber,
        repoId: repo.id,
        title: full.title,
        author: full.author,
        branch,
        url: full.url
      })
    } catch (err) {
      log.warn('could not resolve PR branch', { prNumber: pr.prNumber, err: String(err) })
      store.setPrReviewState(pr.id, 'error')
      return null
    }
  }

  store.setPrReviewState(pr.id, 'provisioning')
  let worktree
  try {
    worktree = await provisionReviewWorktree(repo, pr.prNumber, branch)
  } catch (err) {
    log.error('worktree provision failed', { prNumber: pr.prNumber, err: String(err) })
    store.setPrReviewState(pr.id, 'error')
    store.recordEvent('review.provision_failed', { prReviewId: pr.id, err: String(err) }, { level: 'error' })
    return null
  }

  const realGit = await resolveRealGit()
  // Sandbox the right CLIs / env vars for the repo's owning forge.
  const { env, shimDir } = buildReviewSandbox({
    worktreePath: worktree.path,
    realGit,
    forge: repo.forge
  })
  store.recordEvent('review.sandbox_built', { prReviewId: pr.id, shimDir }, { sessionId: null })

  const prompt = (harness.reviewPrompt ?? '') +
    `\n\nThe PR under review is #${pr.prNumber} "${pr.title}" on branch ${branch}. ` +
    `Base branch is ${repo.defaultBranch}. Write your verdict to ${REVIEW_FILE} in this directory.\n`

  const sessionId = sessionManager.spawn({
    kind: 'review',
    workRef: `review:${pr.id}`,
    harness,
    cwd: worktree.path,
    env,
    worktreeId: worktree.id,
    title: `Review #${pr.prNumber} ${pr.title}`.slice(0, 80),
    initialInput: prompt
  })

  store.attachWorktreeSession(worktree.id, sessionId)
  store.attachSessionToWork('review', pr.id, sessionId)
  store.setPrReviewState(pr.id, 'review_in_progress')
  return sessionId
}

/**
 * Harvest completed reviews. For each in-progress review session, look for the
 * review file; when found, persist the summary, end the session, prune the
 * worktree, and move the PR to awaiting_user. Called each brain tick.
 */
export async function harvestReviews(): Promise<void> {
  const reviews = store.listPrReviews().filter((p) => p.state === 'review_in_progress')
  for (const pr of reviews) {
    const sessionId = pr.sessionId
    if (!sessionId) continue
    const session = store.getSession(sessionId)
    if (!session) continue
    const worktree = session.worktreeId ? store.getWorktree(session.worktreeId) : null
    if (!worktree) continue

    const filePath = join(worktree.path, REVIEW_FILE)
    if (existsSync(filePath)) {
      await captureReview(pr, filePath, worktree, sessionId)
      continue
    }

    // Session ended without producing the file -> needs human.
    if (!sessionManager.isLive(sessionId) && (session.status === 'exited' || session.status === 'killed')) {
      log.warn('review session ended with no review file', { prReviewId: pr.id })
      store.setSessionStatus(sessionId, 'needs_human', 'no review file produced')
      store.recordEvent('review.no_output', { prReviewId: pr.id }, { level: 'warn', sessionId })
      notifier.notify({
        kind: 'needs_human',
        title: `Review needs attention — PR #${pr.prNumber}`,
        body: 'The review session ended without producing a summary.',
        deepLink: { type: 'session', id: sessionId }
      })
      store.setPrReviewState(pr.id, 'error')
    }
  }
}

async function captureReview(
  pr: PrReview,
  filePath: string,
  worktree: { id: number; path: string; repoId: number; branch: string; kind: 'dev' | 'review'; sessionId: number | null; createdAt: string; prunedAt: string | null },
  sessionId: number
): Promise<void> {
  let parsed
  try {
    parsed = ReviewResultSchema.parse(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch (err) {
    log.warn('review file invalid', { prReviewId: pr.id, err: String(err) })
    return // leave in progress; maybe still being written
  }

  store.insertReview({
    prReviewId: pr.id,
    recommendation: parsed.recommendation,
    summary: parsed.summary,
    findings: parsed.findings
  })
  store.recordEvent('review.captured', { prReviewId: pr.id, recommendation: parsed.recommendation }, { sessionId })

  // Review work is done: end the session and prune the (read-only) worktree.
  sessionManager.kill(sessionId, 'review captured')
  await pruneWorktree(worktree)

  store.setPrReviewState(pr.id, 'awaiting_user')
  store.setClaimState('review', pr.id, 'done')
  notifier.notify({
    kind: 'review_ready',
    title: `Review ready — PR #${pr.prNumber}`,
    body: `${parsed.recommendation.replace('_', ' ')}: ${parsed.summary.slice(0, 120)}`,
    deepLink: { type: 'review', id: pr.id }
  })
}

/**
 * Approve-only: approve the PR on the active forge with NO comment body (a
 * bare approval), regardless of whether an AI summary exists. Cleans up any
 * in-flight review session/worktree first.
 */
export async function approveOnly(prReviewId: number): Promise<void> {
  const pr = store.getPrReview(prReviewId)
  if (!pr) throw new Error(`pr_review ${prReviewId} not found`)
  const repo = store.getRepo(pr.repoId)
  if (!repo) throw new Error('repo missing')
  const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())

  // Tear down any in-flight review attempt for this PR.
  if (pr.sessionId) {
    const sess = store.getSession(pr.sessionId)
    if (sess) {
      if (sessionManager.isLive(sess.id)) sessionManager.kill(sess.id, 'approved')
      if (sess.worktreeId) {
        const wt = store.getWorktree(sess.worktreeId)
        if (wt && !wt.prunedAt) await pruneWorktree(wt)
      }
    }
  }

  await forge.submitReview(repo.name, pr.prNumber, 'approve', '', forgeConfig) // bare approval, no comment
  const existing = store.getLatestReviewForPr(prReviewId)
  if (existing) store.recordReviewAction(existing.id, 'approve')
  store.setPrReviewState(pr.id, 'submitted')
  store.setClaimState('review', pr.id, 'done')
  store.recordEvent('review.approved_only', { prReviewId, prNumber: pr.prNumber })
}

/**
 * Act on a review from the UI. Approve/request-changes/comment post through
 * the repo's owning forge adapter (main process, sandbox-free); dismiss just
 * records the decision.
 */
export async function actOnReview(reviewId: number, action: ReviewAction): Promise<void> {
  const review = store.listReviews().find((r) => r.id === reviewId)
  if (!review) throw new Error(`review ${reviewId} not found`)
  const pr = store.getPrReview(review.prReviewId)
  if (!pr) throw new Error(`pr_review ${review.prReviewId} not found`)
  const repo = store.getRepo(pr.repoId)
  if (!repo) throw new Error('repo missing')
  const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())

  if (action === 'dismiss') {
    store.recordReviewAction(reviewId, action)
    store.setPrReviewState(pr.id, 'dismissed')
    store.recordEvent('review.dismissed', { prReviewId: pr.id })
    return
  }

  await forge.submitReview(repo.name, pr.prNumber, action, review.summary, forgeConfig)
  store.recordReviewAction(reviewId, action)
  store.setPrReviewState(pr.id, 'submitted')
  store.recordEvent('review.submitted', { prReviewId: pr.id, action })
}
