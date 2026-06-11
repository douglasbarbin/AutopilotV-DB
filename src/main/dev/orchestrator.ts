import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import {
  provisionDevWorktree,
  provisionDevWorktreeForBranch,
  discardWorktree
} from '../worktree/manager'
import { forgeForRepo, type AdoptablePr } from '../forges'
import { activeTracker } from '../trackers'
import { tickState } from '../brain/tickState'
import type { TrackerTask, Repo, Settings } from '@shared/types/domain'
import { buildDevStartPrompt, sanitizeTitle } from './prompt'
import { ADVANCE_FNS, finishMerged as finishMergedPhase } from './phases'

/**
 * High-level dev-line orchestrator. Owns the user-facing entry points
 * (start/takeover/reset/publish/merge) and the per-tick driver. The per-phase
 * advance functions live in ./phases.ts.
 */

function note(category: 'dev', message: string, detail?: Record<string, unknown>, level: 'info' | 'warn' = 'info') {
  store.recordBrainNote({ tick: tickState.current, category, message, detail, level })
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Pick the repo a dev task targets. A project→repo mapping (if set) wins;
 * otherwise fall back to a watched, locally-cloned repo.
 */
function pickDevRepo(task: TrackerTask): { repo: Repo | null; reason?: string } {
  const mapped = store.resolveProjectRepo(task.projectKey)
  if (mapped) {
    if (mapped.cloneState === 'present') return { repo: mapped }
    return {
      repo: null,
      reason: `project ${task.projectKey} maps to ${mapped.name}, which isn't cloned under your clone dir`
    }
  }
  const repos = store.listRepos().filter((r) => r.cloneState === 'present')
  if (repos.length === 0) return { repo: null, reason: 'no watched repo is cloned locally' }
  const watched = new Set(store.getSettings().watchRepos)
  return { repo: repos.find((r) => watched.has(r.name)) ?? repos[0] }
}

/**
 * Claim → implement: create a feature worktree/branch and spawn the dev harness
 * with a prompt to implement the task and open a DRAFT PR. Sets phase=implementing.
 */
export async function startDevTask(task: TrackerTask): Promise<number | null> {
  const { repo, reason } = pickDevRepo(task)
  if (!repo) {
    note('dev', `Can't start ${task.issueKey} — ${reason}.`, { key: task.issueKey }, 'warn')
    store.setTaskPhase(task.id, 'error')
    store.setClaimState('dev', task.id, 'error')
    return null
  }
  const harness = store.getCodingHarness()
  if (!harness) {
    store.setTaskPhase(task.id, 'error')
    store.setClaimState('dev', task.id, 'error')
    return null
  }

  const prefix = (store.getSettings().branchPrefix || 'autopilotv/').replace(/\/*$/, '/')
  const branch = `${prefix}${task.issueKey}-${slug(task.title)}`
  let worktree
  try {
    worktree = await provisionDevWorktree(repo, branch)
  } catch (err) {
    log.error('dev worktree provision failed', { taskId: task.id, err: String(err) })
    note('dev', `Couldn't create a worktree for ${task.issueKey}: ${String(err).slice(0, 80)}`, {}, 'warn')
    store.setTaskPhase(task.id, 'error')
    store.setClaimState('dev', task.id, 'error')
    return null
  }

  store.setTaskRepo(task.id, repo.id)
  store.setTaskWorktree(task.id, worktree.id)
  store.setTaskPhase(task.id, 'implementing')

  try {
    const { tracker, config } = activeTracker(store.getSettings())
    await tracker.transition(task.issueKey, 'In Progress', config)
    store.setTaskStatus(task.id, 'in_progress')
  } catch (err) {
    log.warn('tracker transition to In Progress failed', { key: task.issueKey, err: String(err) })
  }

  const prompt = buildDevStartPrompt({
    issueKey: task.issueKey,
    title: task.title,
    branch,
    baseBranch: repo.defaultBranch,
    repoName: repo.name,
    worktreePath: worktree.path
  })

  const sessionId = sessionManager.spawn({
    kind: 'dev',
    workRef: `dev:${task.id}`,
    harness,
    cwd: worktree.path,
    env: process.env,
    worktreeId: worktree.id,
    title: `${task.issueKey} ${sanitizeTitle(task.title)}`.slice(0, 80),
    initialInput: prompt
  })
  store.attachWorktreeSession(worktree.id, sessionId)
  store.attachSessionToWork('dev', task.id, sessionId)
  note('dev', `Claimed ${task.issueKey} and started implementation in ${repo.name}.`, { key: task.issueKey })
  return sessionId
}

/**
 * Take over (delegate) an in-flight task that the brain won't auto-claim because
 * it isn't a fresh "To Do" item. Resolves a PR to adopt — an explicit number wins,
 * otherwise it tries to discover one by the issue key — and jumps the task straight
 * into the matching phase (draft awaiting publish, or in_review babysitting) on a
 * worktree checked out to the PR's branch. With no PR to adopt it falls back to a
 * fresh implementation, exactly like a normal claim.
 */
export async function delegateDevTask(task: TrackerTask, prNumberHint?: number): Promise<void> {
  const { repo, reason } = pickDevRepo(task)
  if (!repo) {
    note('dev', `Can't take over ${task.issueKey} — ${reason}.`, { key: task.issueKey }, 'warn')
    store.setTaskPhase(task.id, 'error')
    store.setClaimState('dev', task.id, 'error')
    return
  }

  // Resolve the PR to adopt: an explicit number wins, else discover by issue key.
  let pr: AdoptablePr | null = null
  const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())
  if (prNumberHint) {
    pr = await forge.getAdoptablePr(repo.name, prNumberHint, forgeConfig)
    if (!pr) {
      note(
        'dev',
        `PR #${prNumberHint} not found in ${repo.name} — taking over ${task.issueKey} with a fresh branch instead.`,
        { key: task.issueKey },
        'warn'
      )
    }
  } else {
    pr = await forge.findPrForTask(repo.name, task.issueKey, forgeConfig)
    if (pr) note('dev', `Found existing PR #${pr.number} for ${task.issueKey} — adopting it.`, { key: task.issueKey })
  }

  // No open PR to adopt → take over by implementing from scratch.
  if (!pr || pr.state !== 'OPEN') {
    if (pr && pr.state !== 'OPEN') {
      note(
        'dev',
        `PR #${pr.number} for ${task.issueKey} is ${pr.state.toLowerCase()} — taking over with a fresh branch.`,
        { key: task.issueKey },
        'warn'
      )
    }
    await startDevTask(task)
    return
  }

  // Adopt the existing PR: worktree on its branch, jump to the right phase.
  let worktree
  try {
    worktree = await provisionDevWorktreeForBranch(repo, pr.branch)
  } catch (err) {
    log.error('takeover worktree provision failed', { taskId: task.id, err: String(err) })
    note('dev', `Couldn't check out PR #${pr.number}'s branch for ${task.issueKey}: ${String(err).slice(0, 80)}`, {}, 'warn')
    store.setTaskPhase(task.id, 'error')
    store.setClaimState('dev', task.id, 'error')
    return
  }

  store.setTaskRepo(task.id, repo.id)
  store.setTaskWorktree(task.id, worktree.id)
  store.setTaskPr(task.id, pr.number, pr.url)
  const phase = pr.isDraft ? 'draft' : 'in_review'
  store.setTaskPhase(task.id, phase)
  store.setTaskStatus(task.id, pr.isDraft ? 'in_progress' : 'in_review')
  store.setClaimState('dev', task.id, 'in_progress')
  store.recordEvent('dev.delegated', {
    taskId: task.id,
    prNumber: pr.number,
    phase,
    viaHint: !!prNumberHint
  })
  note(
    'dev',
    `Took over ${task.issueKey} on PR #${pr.number} — ${
      pr.isDraft ? 'a draft awaiting publish' : 'babysitting review'
    }.`,
    { key: task.issueKey }
  )
  // No session spawned now; advanceDevTasks drives it from here (publish / babysit).
}

/**
 * Internal change request on a draft: spawn a session in the existing worktree to
 * make the requested changes and push to the draft PR. Moves to 'revising' and
 * returns to 'draft' when the session finishes.
 */
export async function requestDevChanges(taskId: number, instructions: string): Promise<void> {
  const task = store.getTask(taskId)
  if (!task) return
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo || !worktree) {
    note('dev', `Can't request changes for ${task.issueKey} — its worktree is gone.`, {}, 'warn')
    return
  }
  const harness = store.getCodingHarness()
  if (!harness || !instructions.trim()) return

  const { writeAdjacentWorkFile } = await import('../worktree/manager')
  const { SIGNAL } = await import('../worktree/signals')
  const { buildSignalInstruction, AGENTS_MERGE_UNBLOCK } = await import('./prompt')
  if (worktree && repo) {
    await writeAdjacentWorkFile(worktree.path, repo.id)
  }

  const prompt =
    `Additional change request for ${task.issueKey}${task.prNumber ? ` (PR #${task.prNumber})` : ''}:\n\n` +
    `${instructions.trim()}\n\n` +
    `Make these changes in this worktree on branch ${worktree.branch}, commit, and push to update ` +
    `the existing PR. Do NOT open a new PR.\n\n` +
    buildSignalInstruction(SIGNAL.REVISE, { includePrUrl: false }) +
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
    title: `${task.issueKey} revise`.slice(0, 80),
    initialInput: prompt
  })
  store.attachSessionToWork('dev', task.id, sessionId)
  store.setTaskPhase(task.id, 'revising')
  store.recordEvent('dev.changes_requested', { taskId, prNumber: task.prNumber })
  note('dev', `${task.issueKey}: revising draft per your request.`, { key: task.issueKey })
}

/** Publish a draft PR (user-initiated). The auto-publish path is in
 *  phases.ts → advanceDraft; this entry point is wired to the UI's
 *  Publish button. */
export async function publishDevTask(taskId: number): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || !task.prNumber || !task.repoId) return
  const repo = store.getRepo(task.repoId)
  if (!repo) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())
  await forge.publishPr(repo.name, task.prNumber, forgeConfig)
  store.setTaskPhase(taskId, 'in_review')
  try {
    const { tracker, config } = activeTracker(store.getSettings())
    await tracker.transition(task.issueKey, 'In Review', config)
    store.setTaskStatus(taskId, 'in_review')
  } catch (err) {
    log.warn('tracker transition to In Review failed', { key: task.issueKey, err: String(err) })
  }
  store.recordEvent('dev.published', { taskId, prNumber: task.prNumber })
  note('dev', `Published PR #${task.prNumber} for ${task.issueKey} — now in review.`, { key: task.issueKey })
}

/** Merge a PR (user-initiated), then finish. */
export async function mergeDevTask(taskId: number): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || !task.prNumber || !task.repoId) return
  const repo = store.getRepo(task.repoId)
  if (!repo) return
  const { forge, config: forgeConfig } = forgeForRepo(repo, store.getSettings())
  await forge.mergePr(repo.name, task.prNumber, forgeConfig)
  store.recordEvent('dev.merged', { taskId, prNumber: task.prNumber, via: 'autopilotv' })
  await finishMergedPhase(task)
}

/**
 * Tear a dev task all the way back to unclaimed: kill its session, discard the
 * (possibly dirty) worktree + branch, and clear its workflow columns. Shared by
 * the user's Reset action and the brain's auto-reopen of a bounced-back task.
 */
export async function resetDevTask(taskId: number, eventKind = 'dev.reset'): Promise<void> {
  const task = store.getTask(taskId)
  if (task?.sessionId && sessionManager.isLive(task.sessionId)) {
    sessionManager.kill(task.sessionId, 'dev reset')
  }
  try {
    const { appInstances } = await import('../apps/instances')
    await appInstances.stopForTask(taskId, 'dev reset')
  } catch {
    /* nothing running */
  }
  if (task?.worktreeId) {
    const wt = store.getWorktree(task.worktreeId)
    if (wt && !wt.prunedAt) await discardWorktree(wt)
  }
  store.resetTask(taskId)
  store.recordEvent(eventKind, { taskId })
}

/**
 * Drive every in-flight dev task through its phase, dispatched via the
 * per-phase table in ./phases.ts. Called each tick.
 */
export async function advanceDevTasks(settings: Settings): Promise<void> {
  const tasks = store
    .listTasks()
    .filter((t) => ['implementing', 'draft', 'revising', 'in_review', 'ready_to_merge'].includes(t.phase))

  for (const task of tasks) {
    try {
      await ADVANCE_FNS[task.phase](task, settings)
    } catch (err) {
      log.warn('dev advance failed', { taskId: task.id, err: String(err) })
    }
  }
}
