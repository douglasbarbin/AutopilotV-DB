import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { forgeForRepo } from '../forges'
import { activeTracker } from '../trackers'
import { tickState } from '../brain/tickState'
import { notifier } from '../notify'
import {
  SIGNAL,
  isSignalled,
  consumeReport,
  extractPrUrl,
  type ConsumedSignal
} from '../worktree/signals'
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

/**
 * Persist whatever metadata a consumed signal carried. A structured report is
 * recorded as a `signal.report` event and harvested into the insights store
 * (follow-ups + learned knowledge); malformed JSON is flagged but never blocks
 * the phase transition that the bare signal already triggered.
 */
async function recordSignalReport(task: TrackerTask, phase: string, consumed: ConsumedSignal): Promise<void> {
  if (consumed.malformed) {
    store.recordEvent(
      'signal.malformed',
      { taskId: task.id, issueKey: task.issueKey, phase, raw: consumed.raw.slice(0, 500) },
      { level: 'warn' }
    )
    return
  }
  if (consumed.report) {
    store.recordEvent('signal.report', {
      taskId: task.id,
      issueKey: task.issueKey,
      phase,
      summary: consumed.report.summary,
      followUps: consumed.report.followUps,
      learnings: consumed.report.learnings,
      deviations: consumed.report.deviations
    })
    try {
      // Lazy import, same rationale as ./verify below.
      const { harvestSignalReport } = await import('../analysis/engine')
      await harvestSignalReport(task, consumed.report)
    } catch (err) {
      log.warn('signal report harvest failed', { taskId: task.id, err: String(err) })
    }
  }
}

// ──────────────────────────── per-phase advances ────────────────────────────

/**
 * implementing → draft (or error).
 *
 * The implementing agent signals "done" by writing the IMPL signal (or by
 * leaving a PR open on the branch, which we discover via the forge).
 */
export async function advanceImplementing(task: TrackerTask, settings: Settings): Promise<void> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo || !worktree) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, settings)

  // Consume the agent's IMPL signal first; fall back to forge discovery.
  let pr: { number: number; url: string; isDraft?: boolean } | null = null
  let viaFile = false
  if (worktree.path && isSignalled(worktree.path, SIGNAL.IMPL)) {
    const consumed = consumeReport(worktree.path, SIGNAL.IMPL)
    if (consumed) {
      await recordSignalReport(task, 'impl', consumed)
      const url = extractPrUrl(consumed)
      const m = url?.match(/\/(?:pullrequest|pull)\/(\d+)/i)
      if (url && m) pr = { number: Number(m[1]), url }
    }
  }
  if (!pr) pr = await forge.findPrForBranch(repo.name, worktree.branch, forgeConfig)
  else viaFile = true

  if (pr) {
    store.setTaskPr(task.id, pr.number, pr.url)
    store.setTaskPhase(task.id, 'draft')
    killTaskSessionIfLive(task, 'draft PR opened')
    note('dev', `${task.issueKey} opened draft PR #${pr.number}${viaFile ? ` (via ${SIGNAL.IMPL})` : ''}.`, {
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
    if (signalled && worktree) {
      const consumed = consumeReport(worktree.path, SIGNAL.REVISE)
      if (consumed) await recordSignalReport(task, 'revise', consumed)
    }
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
 * Spawn a verification-fix session only when an agent can plausibly help:
 *  - never for the secrets stage (a locked secrets manager / broken runbook
 *    is the operator's to fix; the pipeline already sent a notification);
 *  - at most ONCE per commit — a fix session that ended without producing a
 *    new commit didn't fix anything, and respawning on the same SHA loops
 *    forever burning sessions.
 */
async function maybeSpawnVerificationFix(
  task: TrackerTask,
  repo: Repo,
  worktree: { path: string; id: number } | null,
  verdict: { failureSummary?: string; failureStage?: string }
): Promise<void> {
  if (verdict.failureStage === 'secrets') {
    note(
      'dev',
      `${task.issueKey}: verification is blocked on the SECRETS stage — fix the runbook or unlock the secrets manager, then Refresh secrets. Not spawning an agent (it can't fix that).`,
      { key: task.issueKey },
      'warn'
    )
    return
  }
  const { currentSha } = await import('./verify')
  const sha = worktree ? await currentSha(worktree.path) : ''
  const spawnKey = `fixspawned:${task.id}:${sha}`
  if (sha && store.kvRead(spawnKey)) {
    note(
      'dev',
      `${task.issueKey}: a fix session already ran for commit ${sha.slice(0, 7)} without resolving verification — holding for a human or a new commit.`,
      { key: task.issueKey },
      'warn'
    )
    return
  }
  if (sha) store.kvWrite(spawnKey, new Date().toISOString())
  await startVerificationFix(task, repo, worktree, verdict.failureSummary ?? 'Verification failed.')
  notifier.notify({
    kind: 'needs_human',
    title: `Verification failed — ${task.issueKey}`,
    body: `PR #${task.prNumber} failed verification. Auto-fixing.`,
    deepLink: { type: 'task', id: task.id }
  })
}

/**
 * Draft checkpoint: as soon as a draft PR exists, prove the change RUNNABLE
 * with the full runbook pipeline (setup → secrets → build → test → app+e2e)
 * before a human looks at it. A failure spawns a verification-fix session and
 * holds auto-publish; a new pushed commit re-runs the checkpoint. Repos
 * without runbook stages skip this (the merge gate's legacy command covers
 * them).
 *
 * Returns true when the draft is proven (or the checkpoint doesn't apply).
 */
async function runDraftCheckpoint(task: TrackerTask, settings: Settings): Promise<boolean> {
  if (!settings.verifyBeforeReady || !task.prNumber || !task.repoId || !task.worktreeId) return true
  const repo = store.getRepo(task.repoId)
  const worktree = store.getWorktree(task.worktreeId)
  if (!repo || !worktree || worktree.prunedAt) return true

  const { hasRunbookStages, runPipeline, verdictIsCurrent } = await import('./pipeline')
  if (!hasRunbookStages(repo)) return true

  // A verification-fix session signals completion with the address-comments
  // signal; in the draft phase we consume it here.
  if (worktree.path && isSignalled(worktree.path, SIGNAL.ADDRESS_COMMENTS)) {
    const consumed = consumeReport(worktree.path, SIGNAL.ADDRESS_COMMENTS)
    if (consumed) await recordSignalReport(task, 'address_comments', consumed)
    killTaskSessionIfLive(task, 'verification fix complete')
  }
  if (isTaskSessionActive(task)) return false // fix session still working

  const { currentSha } = await import('./verify')
  const sha = await currentSha(worktree.path)
  if (!sha) return true

  // A verdict only stands while the runbook is unchanged — editing the
  // runbook invalidates it so the same commit gets re-verified.
  const existing = store.getPipelineVerdict(task.id, 'draft', sha)
  if (existing && verdictIsCurrent(repo, existing)) {
    // 'error' rollups (e.g. invalid runbook) surface but never block.
    return existing.status !== 'fail'
  }

  const r = await runPipeline(task, repo, worktree, settings, 'draft', sha)
  if (r.ok) {
    note('dev', `${task.issueKey}: draft checkpoint passed — change proven runnable at ${sha.slice(0, 7)}.`, {
      key: task.issueKey
    })
    return true
  }
  await maybeSpawnVerificationFix(task, repo, worktree, {
    failureSummary: r.failureSummary,
    failureStage: r.failedStage
  })
  return false
}

/**
 * draft → in_review (auto-publish if `settings.autoPublish`, else wait for the
 * user's Publish click from the UI). The draft checkpoint runs first either
 * way; auto-publish is held until the change is proven runnable. (A manual
 * Publish click remains an explicit human override.)
 */
export async function advanceDraft(task: TrackerTask, settings: Settings): Promise<void> {
  const proven = await runDraftCheckpoint(task, settings)
  if (!proven) return
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
  // Surface reviewer progress on the task card.
  store.setTaskReviewCounts(task.id, r.approvals, Math.max(r.reviewersRequested ?? 0, r.approvals))

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

  // Lazily load the verification helpers. Imported here (not at module top) so
  // that re-importing this module under a mocked '../forges' — as the
  // orchestration tests do — doesn't eagerly evaluate verify → forges/provider/
  // store and deadlock the test module resolver.
  const { verifyTaskForMerge, currentSha } = await import('./verify')

  // Consume any address-comments signal.
  const addrSignalled = worktree ? isSignalled(worktree.path, SIGNAL.ADDRESS_COMMENTS) : false
  if (addrSignalled && worktree) {
    const consumed = consumeReport(worktree.path, SIGNAL.ADDRESS_COMMENTS)
    if (consumed) await recordSignalReport(task, 'address_comments', consumed)
    killTaskSessionIfLive(task, 'comments addressed')
    // Record the commit we just pushed and the current open-thread count, so a
    // sticky "changes requested" review doesn't re-spawn another round on the
    // same work — but a later additional comment (higher count) still will.
    const pushed = await currentSha(worktree.path)
    if (pushed) store.setTaskAddressed(task.id, pushed, r.unresolvedThreads)
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
      // Independent verification gate (theme B): run the repo's own test/build
      // command on the pushed branch before surfacing the PR as ready_to_merge.
      // A failure keeps the task in review, records it, and auto-spawns a fix
      // session; only a new pushed commit re-triggers verification.
      if (settings.verifyBeforeReady) {
        const verdict = await verifyTaskForMerge(task, settings)
        if (!verdict.ok) {
          if (!isTaskSessionActive(task)) {
            await maybeSpawnVerificationFix(task, repo, worktree, verdict)
          }
          return
        }
      }
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
      // Address feedback when there's something NEW to do, then wait. GitHub's
      // "changes requested" review state is sticky (stays true until the
      // reviewer re-reviews or dismisses), so spawning whenever it's set loops
      // forever even after every thread is resolved and the fix is pushed. We
      // run a round only when the PR head advanced since we last addressed
      // (newCommit) OR an additional comment arrived (more unresolved threads
      // than we last handled); otherwise we wait for the review state to change.
      const headSha = worktree ? await currentSha(worktree.path) : ''
      const newCommit = !!headSha && headSha !== task.addressedSha
      const moreComments = r.unresolvedThreads > task.addressedThreads
      if (headSha && (newCommit || moreComments)) {
        store.setTaskAddressed(task.id, headSha, r.unresolvedThreads)
        await startAddressComments(task, repo, worktree)
      }
    } else if (r.mergeable === false && !isTaskSessionActive(task)) {
      // The PR conflicts with the base branch (or a half-finished merge is
      // sitting in the worktree). Without this, the task just parks in
      // babysitting forever. One automated resolution attempt per head commit.
      await maybeStartConflictFix(task, repo, worktree)
    }
    return
  }

  // ready_to_merge: regressed? (new changes requested) → back to in_review.
  // Clear addressed_sha so this fresh feedback gets exactly one address round.
  if (!satisfied && (r.changesRequested || r.unresolvedThreads > 0)) {
    store.setTaskPhase(task.id, 'in_review')
    store.setTaskAddressed(task.id, '', 0)
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

  const { buildSignalInstruction, AGENTS_MERGE_UNBLOCK } = await import('./prompt')
  const prompt =
    `Reviewers left feedback on PR #${task.prNumber} (${repo.name}).\n` +
    `Read the unresolved review comments (e.g. \`gh pr view ${task.prNumber} --comments\`), ` +
    `address them in this worktree, commit, and push to the same branch. ` +
    `Reply to or resolve threads where appropriate.\n\n` +
    buildSignalInstruction(SIGNAL.ADDRESS_COMMENTS, { includePrUrl: false }) +
    `\n\n` +
    `Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.\n` +
    `\n${AGENTS_MERGE_UNBLOCK}\n`
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

/**
 * Spawn a session to resolve a merge conflict with the base branch. The PR is
 * reported not-mergeable by the forge; the agent merges the base branch into
 * the PR branch in the existing worktree, resolves, and pushes. Reuses the
 * address-comments completion signal. Guarded to ONE attempt per head commit
 * (the pushed merge commit changes the SHA, naturally re-arming the guard).
 */
async function maybeStartConflictFix(
  task: TrackerTask,
  repo: Repo,
  worktree: { path: string; id: number; branch: string } | null
): Promise<void> {
  if (!worktree) return
  const harness = store.getCodingHarness()
  if (!harness) return
  const { currentSha } = await import('./verify')
  const sha = await currentSha(worktree.path)
  if (!sha) return
  const guardKey = `conflictfix:${task.id}:${sha}`
  if (store.kvRead(guardKey)) {
    note(
      'dev',
      `${task.issueKey}: PR #${task.prNumber} is still not mergeable after an automated resolution attempt at ${sha.slice(0, 7)} — holding for a human.`,
      { key: task.issueKey },
      'warn'
    )
    return
  }
  store.kvWrite(guardKey, new Date().toISOString())

  const { writeAdjacentWorkFile } = await import('../worktree/manager')
  await writeAdjacentWorkFile(worktree.path, repo.id)
  const { buildSignalInstruction, AGENTS_MERGE_UNBLOCK } = await import('./prompt')
  const prompt =
    `PR #${task.prNumber} (${repo.name}) is NOT MERGEABLE — it conflicts with ${repo.defaultBranch}, ` +
    `or a previous merge attempt was left half-finished in this worktree.\n\n` +
    `In this worktree on branch ${worktree.branch}:\n` +
    `1. If a merge is already in progress (unmerged paths, .git/MERGE_HEAD), finish or abort it first.\n` +
    `2. If the merge is blocked by local changes to AGENTS.md, follow the unblock recipe at the end of this message.\n` +
    `3. \`git fetch origin\` and \`git merge origin/${repo.defaultBranch}\`. Resolve every conflict faithfully ` +
    `to BOTH sides' intent (read the surrounding code; do not blindly take one side), commit the merge, and push.\n` +
    `Do NOT force-push and do NOT open a new PR.\n\n` +
    buildSignalInstruction(SIGNAL.ADDRESS_COMMENTS, { includePrUrl: false }) +
    `\n\n` +
    `Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.\n` +
    `\n${AGENTS_MERGE_UNBLOCK}\n`

  const sessionId = sessionManager.spawn({
    kind: 'dev',
    workRef: `dev:${task.id}`,
    harness,
    cwd: worktree.path,
    env: process.env,
    worktreeId: worktree.id,
    title: `${task.issueKey} resolve conflicts`.slice(0, 80),
    initialInput: prompt
  })
  store.attachSessionToWork('dev', task.id, sessionId)
  store.recordEvent('dev.conflict_fix_started', { taskId: task.id, prNumber: task.prNumber, sha })
  note('dev', `${task.issueKey}: PR #${task.prNumber} conflicts with ${repo.defaultBranch} — spawned a resolution session.`, {
    key: task.issueKey
  }, 'warn')
}

/**
 * Spawn a fix session after independent verification failed (theme B). Reuses
 * the existing worktree and the `.address-comments` completion signal, so the
 * normal re-check path applies; the agent's new commit changes the branch SHA,
 * which re-triggers verification on the next tick.
 */
async function startVerificationFix(
  task: TrackerTask,
  repo: Repo,
  worktree: { path: string; id: number } | null,
  failureSummary: string
): Promise<void> {
  if (!worktree) return
  const harness = store.getCodingHarness()
  if (!harness) return

  const { writeAdjacentWorkFile } = await import('../worktree/manager')
  await writeAdjacentWorkFile(worktree.path, repo.id)

  const { buildSignalInstruction, AGENTS_MERGE_UNBLOCK } = await import('./prompt')
  const prompt =
    `Automated verification FAILED for PR #${task.prNumber} (${repo.name}) before it could be marked ready to merge.\n\n` +
    `Verification output:\n${failureSummary.slice(0, 3000)}\n\n` +
    `Diagnose and fix the failure in this worktree on the PR's branch, commit, and push to update the existing PR. ` +
    `Do NOT open a new PR.\n\n` +
    buildSignalInstruction(SIGNAL.ADDRESS_COMMENTS, { includePrUrl: false }) +
    `\n\n` +
    `Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.\n` +
    `\n${AGENTS_MERGE_UNBLOCK}\n`

  const sessionId = sessionManager.spawn({
    kind: 'dev',
    workRef: `dev:${task.id}`,
    harness,
    cwd: worktree.path,
    env: process.env,
    worktreeId: worktree.id,
    title: `${task.issueKey} fix verification`.slice(0, 80),
    initialInput: prompt
  })
  store.attachSessionToWork('dev', task.id, sessionId)
  store.recordEvent('dev.verify_fix_started', { taskId: task.id, prNumber: task.prNumber })
  note('dev', `${task.issueKey}: verification failed on PR #${task.prNumber} — spawned a fix session.`, {
    key: task.issueKey
  }, 'warn')
}

/** PR merged → stop tracking. Run post-merge analysis (it needs the worktree's
 *  diff, so it runs before pruning), prune the worktree; do NOT touch the
 *  tracker (QA owns Done). */
export async function finishMerged(task: TrackerTask): Promise<void> {
  if (task.sessionId && sessionManager.isLive(task.sessionId)) {
    sessionManager.kill(task.sessionId, 'pr merged')
  }
  try {
    const { appInstances } = await import('../apps/instances')
    await appInstances.stopForTask(task.id, 'task merged')
  } catch {
    /* no instances module loaded — nothing running */
  }
  try {
    const { runPostMergeAnalysis } = await import('../analysis/engine')
    await runPostMergeAnalysis(task, store.getSettings())
  } catch (err) {
    log.warn('post-merge analysis failed', { taskId: task.id, err: String(err) })
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
