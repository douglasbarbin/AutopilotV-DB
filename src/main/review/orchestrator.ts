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
import type { PrReview, PrReviewState, ReviewAction } from '@shared/types/domain'

const REVIEW_FILE = '.review.json'

/** States in which a pr_review still expects something to happen to the PR. */
const OPEN_REVIEW_STATES: PrReviewState[] = [
  'discovered',
  'provisioning',
  'review_in_progress',
  'awaiting_user'
]

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
  // The prune is filesystem work nothing downstream depends on — run it
  // off-tick so a slow delete can't hold up the rest of the harvest pass.
  sessionManager.kill(sessionId, 'review captured')
  void pruneWorktree(worktree).catch((err) =>
    log.warn('review worktree prune failed', { prReviewId: pr.id, err: String(err) })
  )

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
 * Tear down a review whose PR was resolved externally (merged or closed before
 * our review was used): kill any in-flight session, prune the worktree, and
 * mark the row superseded so it leaves the queue without a human action.
 */
export async function supersedeReview(pr: PrReview, reason: string): Promise<void> {
  if (pr.sessionId) {
    const sess = store.getSession(pr.sessionId)
    if (sess) {
      if (sessionManager.isLive(sess.id)) sessionManager.kill(sess.id, `superseded: ${reason}`)
      if (sess.worktreeId) {
        const wt = store.getWorktree(sess.worktreeId)
        if (wt && !wt.prunedAt) {
          void pruneWorktree(wt).catch((err) =>
            log.warn('superseded review worktree prune failed', { prReviewId: pr.id, err: String(err) })
          )
        }
      }
    }
  }
  store.setPrReviewState(pr.id, 'superseded')
  store.setClaimState('review', pr.id, 'done')
  store.recordEvent('review.superseded', { prReviewId: pr.id, prNumber: pr.prNumber, reason })
}

/**
 * Reconcile the review lane against the forge: any pr_review still expecting
 * action whose PR has merged or closed externally is superseded — there is no
 * branch left to review. Absence from the review-requested list is only the
 * TRIGGER for a check; the per-PR state lookup is what's authoritative, so a
 * withdrawn review request (PR still open) is left alone, and a repo whose
 * discovery errored this tick is skipped entirely.
 */
export async function reconcileExternallyResolvedReviews(
  stillRequested: Set<string>, // keys: `${repoId}:${prNumber}`
  erroredRepos: Set<string> // repo names whose discovery failed this tick
): Promise<{ prNumber: number; title: string; reason: string }[]> {
  const settings = store.getSettings()
  const superseded: { prNumber: number; title: string; reason: string }[] = []
  for (const pr of store.listPrReviews()) {
    if (!OPEN_REVIEW_STATES.includes(pr.state)) continue
    if (stillRequested.has(`${pr.repoId}:${pr.prNumber}`)) continue
    const repo = store.getRepo(pr.repoId)
    if (!repo || erroredRepos.has(repo.name)) continue
    let adopt
    try {
      const { forge, config } = forgeForRepo(repo, settings)
      adopt = await forge.getAdoptablePr(repo.name, pr.prNumber, config)
    } catch {
      continue // transient forge error — try again next tick rather than guess
    }
    if (adopt && adopt.state === 'OPEN') continue
    const reason = !adopt
      ? 'PR no longer exists'
      : adopt.state === 'MERGED'
        ? 'merged externally'
        : 'closed externally'
    await supersedeReview(pr, reason)
    superseded.push({ prNumber: pr.prNumber, title: pr.title, reason })
  }
  return superseded
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

  // The PR may have merged/closed since the card was rendered — supersede
  // instead of posting a review nothing can act on. A failed check is not a
  // veto: only a positively non-open state blocks the submission.
  const fresh = await forge.getAdoptablePr(repo.name, pr.prNumber, forgeConfig).catch(() => undefined)
  if (fresh && fresh.state !== 'OPEN') {
    const why = fresh.state === 'MERGED' ? 'merged' : 'closed'
    await supersedeReview(pr, `${why} externally`)
    throw new Error(`PR #${pr.prNumber} was already ${why} — approval skipped`)
  }

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
  const review = store.getReview(reviewId)
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

  // Same freshness guard as approveOnly: don't post onto a merged/closed PR.
  const fresh = await forge.getAdoptablePr(repo.name, pr.prNumber, forgeConfig).catch(() => undefined)
  if (fresh && fresh.state !== 'OPEN') {
    const why = fresh.state === 'MERGED' ? 'merged' : 'closed'
    await supersedeReview(pr, `${why} externally`)
    throw new Error(`PR #${pr.prNumber} was already ${why} — review not submitted`)
  }

  await forge.submitReview(repo.name, pr.prNumber, action, review.summary, forgeConfig)
  store.recordReviewAction(reviewId, action)
  store.setPrReviewState(pr.id, 'submitted')
  store.recordEvent('review.submitted', { prReviewId: pr.id, action })
}
