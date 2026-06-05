import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { forgeForRepo } from '../forges'
import { activeTracker } from '../trackers'
import { tickState } from '../brain/tickState'
import { notifier } from '../notify'
import { SIGNAL, isSignalled, clear as clearSignal } from '../worktree/signals'
import type { TrackerTask, Repo, Settings, DevPhase } from '@shared/types/domain'

/**
 * Per-phase advance functions for the dev line.
 *
 * Each phase's `advance` function encapsulates the rules for transitioning
 * out of that phase. The previous `advanceOne` was a single 135-line switch
 * that mixed DB writes, session lifecycle, signals, and notifications — hard
 * to test, easy to introduce ordering bugs in.
 *
 * Convention: each function is side-effecting, idempotent within a tick, and
 * returns early when the task isn't ready to transition. Callers (the brain
 * tick) iterate tasks and call the function matching the task's current
 * phase.
 *
 * Shared helpers (session-liveness, file-signal reads, brain-note writer) live
 * at the top; the per-phase functions below compose them.
 */

const OWNER = `autopilotv-${process.pid}`
void OWNER // reserved for future claim owner tagging within phases

function note(category: 'dev', message: string, detail?: Record<string, unknown>, level: 'info' | 'warn' = 'info') {
  store.recordBrainNote({ tick: tickState.current, category, message, detail, level })
}

/** True if a live session is currently driving this task. */
function isTaskSessionActive(task: TrackerTask): boolean {
  if (!task.sessionId) return false
  const s = store.getSession(task.sessionId)
  return !!s && ['starting', 'running', 'stalled', 'needs_human'].includes(s.status) && sessionManager.isLive(s.id)
}

/** Kill the task's session if it's still running, no-op otherwise. */
function killTaskSessionIfLive(task: TrackerTask, reason: string): void {
  if (task.sessionId && sessionManager.isLive(task.sessionId)) {
    sessionManager.kill(task.sessionId, reason)
  }
}

// ──────────────────────────── per-phase advances ────────────────────────────

/**
 * implementing → draft (or error).
 *
 * The implementing agent signals "done" by writing `.pr-url` (or by leaving a
 * PR open on the branch, which we discover via the forge).
 */
export async function advanceImplementing(task: TrackerTask, settings: Settings): Promise<void> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo || !worktree) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, settings)

  // Read the agent's .pr-url signal first; fall back to forge discovery.
  const urlPath = worktree.path
  const fromFile = urlPath && isSignalled(urlPath, SIGNAL.PR_URL) ? urlPath : null
  let pr: { number: number; url: string; isDraft?: boolean } | null = null
  let viaFile = false
  if (fromFile) {
    // Parse the PR URL from the signal file and consume it (delete).
    const content = require('fs').readFileSync(`${fromFile}/${SIGNAL.PR_URL}`, 'utf8') as string
    clearSignal(fromFile, SIGNAL.PR_URL)
    const text = content.trim()
    const m = text.match(/\/(?:pullrequest|pull)\/(\d+)/i)
    if (m) pr = { number: Number(m[1]), url: text.split(/\s+/)[0] }
  }
  if (!pr) pr = await forge.findPrForBranch(repo.name, worktree.branch, forgeConfig)
  else viaFile = true

  if (pr) {
    store.setTaskPr(task.id, pr.number, pr.url)
    store.setTaskPhase(task.id, 'draft')
    killTaskSessionIfLive(task, 'draft PR opened')
    note('dev', `${task.issueKey} opened draft PR #${pr.number}${viaFile ? ' (via .pr-url)' : ''}.`, {
      key: task.issueKey
    })
    return
  }

  // No PR yet. If the implementing session died, it failed to produce one.
  if (!isTaskSessionActive(task)) {
    store.setTaskPhase(task.id, 'error')
    note('dev', `${task.issueKey} implementation ended without opening a PR — needs a human.`, {}, 'warn')
    notifier.notify({
      kind: 'needs_human',
      title: `Dev task needs you — ${task.issueKey}`,
      body: 'Implementation finished without opening a PR.',
      deepLink: { type: 'task', id: task.id }
    })
  }
}

/**
 * revising → draft (or in_review, if the PR is no longer a draft).
 *
 * The revising agent signals completion with `.revise`.
 */
export async function advanceRevising(task: TrackerTask, settings: Settings): Promise<void> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, settings)

  const signalled = worktree ? isSignalled(worktree.path, SIGNAL.REVISE) : false
  if (signalled || !isTaskSessionActive(task)) {
    if (signalled && worktree) clearSignal(worktree.path, SIGNAL.REVISE)
    killTaskSessionIfLive(task, 'revision complete')

    let next: DevPhase = 'draft'
    if (worktree && task.prNumber) {
      const pr = await forge.findPrForBranch(repo.name, worktree.branch, forgeConfig)
      if (pr && pr.isDraft === false) next = 'in_review'
    }
    store.setTaskPhase(task.id, next)
    note(
      'dev',
      `${task.issueKey}: revisions complete — back to ${next === 'in_review' ? 'review' : 'draft'}.`,
      { key: task.issueKey }
    )
  }
}

/**
 * draft → in_review (auto-publish if `settings.autoPublish`, else wait for the
 * user's Publish click from the UI).
 */
export async function advanceDraft(task: TrackerTask, settings: Settings): Promise<void> {
  if (!settings.autoPublish) return
  if (!task.prNumber) return
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  if (!repo) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, settings)
  await forge.publishPr(repo.name, task.prNumber, forgeConfig)
  store.setTaskPhase(task.id, 'in_review')
  try {
    const { tracker, config } = activeTracker(settings)
    await tracker.transition(task.issueKey, 'In Review', config)
    store.setTaskStatus(task.id, 'in_review')
  } catch (err) {
    log.warn('tracker transition to In Review failed', { key: task.issueKey, err: String(err) })
  }
  store.recordEvent('dev.published', { taskId: task.id, prNumber: task.prNumber })
  note('dev', `Published PR #${task.prNumber} for ${task.issueKey} — now in review.`, { key: task.issueKey })
}

/**
 * in_review / ready_to_merge — drives the babysit loop.
 *
 *  - consume `.address-comments` signal (kill the session)
 *  - check PR readiness; on merge → finishMerged
 *  - on closed → completeTask
 *  - on changes-requested / unresolved threads without an active session
 *    → spawn an address-comments session
 *  - in_review → ready_to_merge when the configured gates are met
 *  - ready_to_merge regresses back to in_review if new feedback arrives
 */
export async function advanceReview(task: TrackerTask, settings: Settings): Promise<void> {
  if (!task.prNumber || !task.repoId) return
  const repo = store.getRepo(task.repoId)
  if (!repo) return
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  const { forge, config: forgeConfig } = forgeForRepo(repo, settings)

  const r = await forge.getPrReadiness(repo.name, task.prNumber, forgeConfig)

  if (r.state === 'MERGED') {
    const t = store.getTask(task.id)
    if (t) await finishMerged(t)
    return
  }
  if (r.state === 'CLOSED') {
    store.completeTask(task.id)
    note('dev', `PR #${task.prNumber} for ${task.issueKey} was closed — no longer tracking.`, {}, 'warn')
    return
  }

  // Consume any address-comments signal.
  const addrSignalled = worktree ? isSignalled(worktree.path, SIGNAL.ADDRESS_COMMENTS) : false
  if (addrSignalled && worktree) {
    clearSignal(worktree.path, SIGNAL.ADDRESS_COMMENTS)
    killTaskSessionIfLive(task, 'comments addressed')
    note('dev', `${task.issueKey}: finished addressing review comments on PR #${task.prNumber}.`, {
      key: task.issueKey
    })
  }

  const satisfied =
    r.approvals >= settings.requiredApprovals &&
    r.unresolvedThreads === 0 &&
    !r.changesRequested &&
    r.mergeable &&
    r.statusOk

  if (task.phase === 'in_review') {
    if (satisfied) {
      killTaskSessionIfLive(task, 'ready to merge')
      store.setTaskPhase(task.id, 'ready_to_merge')
      store.recordEvent('dev.ready_to_merge', { taskId: task.id, prNumber: task.prNumber })
      note(
        'dev',
        `${task.issueKey} PR #${task.prNumber} is green (${r.approvals}/${settings.requiredApprovals} approvals, 0 unresolved) — ready for your merge.`,
        { key: task.issueKey }
      )
      notifier.notify({
        kind: 'pr_ready_to_merge',
        title: `PR ready to merge — ${task.issueKey}`,
        body: `PR #${task.prNumber} satisfied all gates. Merge when ready.`,
        deepLink: { type: 'task', id: task.id }
      })
    } else if ((r.changesRequested || r.unresolvedThreads > 0) && !isTaskSessionActive(task)) {
      // Spawn a session to address feedback in the existing worktree.
      await startAddressComments(task, repo, worktree)
    }
    return
  }

  // ready_to_merge: regressed? (new changes requested) → back to in_review.
  if (!satisfied && (r.changesRequested || r.unresolvedThreads > 0)) {
    store.setTaskPhase(task.id, 'in_review')
    note('dev', `${task.issueKey} got new feedback — back to addressing comments.`, {}, 'warn')
  }
}

// ──────────────────────────── session-spawn helpers ─────────────────────────

/**
 * Spawn the address-comments session: an interactive coding session in the
 * existing worktree, told to read the unresolved review comments, push fixes,
 * and signal completion with `.address-comments`.
 */
async function startAddressComments(
  task: TrackerTask,
  repo: Repo,
  worktree: { path: string; id: number } | null
): Promise<void> {
  if (!worktree) return
  const harness = store.getCodingHarness()
  if (!harness) return

  const { writeAdjacentWorkFile } = await import('../worktree/manager')
  await writeAdjacentWorkFile(worktree.path, repo.id)

  const prompt =
    `Reviewers left feedback on PR #${task.prNumber} (${repo.name}).\n` +
    `Read the unresolved review comments (e.g. \`gh pr view ${task.prNumber} --comments\`), ` +
    `address them in this worktree, commit, and push to the same branch. ` +
    `Reply to or resolve threads where appropriate. ` +
    `When you have committed and pushed all fixes, signal completion by creating an empty file ` +
    `named ${SIGNAL.ADDRESS_COMMENTS} in this directory (e.g. \`touch ${SIGNAL.ADDRESS_COMMENTS}\`). ` +
    `That file tells the orchestrator you are done so it can re-check the PR.\n\n` +
    `Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.\n`
  const sessionId = sessionManager.spawn({
    kind: 'dev',
    workRef: `dev:${task.id}`,
    harness,
    cwd: worktree.path,
    env: process.env,
    worktreeId: worktree.id,
    title: `${task.issueKey} address comments`.slice(0, 80),
    initialInput: prompt
  })
  store.attachSessionToWork('dev', task.id, sessionId)
  note('dev', `${task.issueKey}: addressing review feedback on PR #${task.prNumber}.`, { key: task.issueKey })
}

/** PR merged → stop tracking. Prune the worktree; do NOT touch the tracker
 *  (QA owns Done). */
export async function finishMerged(task: TrackerTask): Promise<void> {
  if (task.sessionId && sessionManager.isLive(task.sessionId)) {
    sessionManager.kill(task.sessionId, 'pr merged')
  }
  if (task.worktreeId) {
    const wt = store.getWorktree(task.worktreeId)
    if (wt && !wt.prunedAt) {
      const { pruneWorktree } = await import('../worktree/manager')
      await pruneWorktree(wt)
    }
  }
  store.completeTask(task.id)
  note('dev', `PR #${task.prNumber} for ${task.issueKey} merged — done, no longer tracking.`, { key: task.issueKey })
}

// ──────────────────────────── dispatcher ────────────────────────────

/**
 * Per-phase dispatch table. Tests / the brain tick call the function
 * matching the task's current phase.
 */
export const ADVANCE_FNS: Record<DevPhase, (task: TrackerTask, settings: Settings) => Promise<void>> = {
  unclaimed: async () => {
    /* nothing to advance */
  },
  implementing: advanceImplementing,
  draft: advanceDraft,
  revising: advanceRevising,
  in_review: advanceReview,
  ready_to_merge: advanceReview,
  done: async () => {
    /* terminal */
  },
  error: async () => {
    /* terminal — user must Reset/Retry */
  }
}
