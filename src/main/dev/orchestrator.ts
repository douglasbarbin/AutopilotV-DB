import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import {
  provisionDevWorktree,
  provisionDevWorktreeForBranch,
  pruneWorktree,
  discardWorktree,
  writeAdjacentWorkFile
} from '../worktree/manager'
import * as gh from '../integrations/github'
import { notifier } from '../notify'
import { activeTracker } from '../trackers'
import { tickState } from '../brain/tickState'
import type { TrackerTask, Repo, Settings } from '@shared/types/domain'
import { buildDevStartPrompt, PR_URL_FILE, sanitizeTitle } from './prompt'

const REVISE_FILE = '.revise'
const ADDRESS_FILE = '.address-comments'

/** Read the PR number/url the implementing agent wrote to .pr-url, if present. */
function readPrUrlFile(worktreePath: string): { number: number; url: string } | null {
  const f = join(worktreePath, PR_URL_FILE)
  if (!existsSync(f)) return null
  const content = readFileSync(f, 'utf8').trim()
  if (!content) return null
  const fromUrl = content.match(/\/pull\/(\d+)/)
  if (fromUrl) return { number: Number(fromUrl[1]), url: content.split(/\s+/)[0] }
  const justNumber = content.match(/(\d{1,7})/)
  if (justNumber) return { number: Number(justNumber[1]), url: content }
  return null
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

function note(category: 'dev', message: string, detail?: Record<string, unknown>, level: 'info' | 'warn' = 'info') {
  store.recordBrainNote({ tick: tickState.current, category, message, detail, level })
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

function isTaskSessionActive(task: TrackerTask): boolean {
  if (!task.sessionId) return false
  const s = store.getSession(task.sessionId)
  return !!s && ['starting', 'running', 'stalled', 'needs_human'].includes(s.status) && sessionManager.isLive(s.id)
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
  let pr: gh.AdoptablePr | null = null
  if (prNumberHint) {
    pr = await gh.getAdoptablePr(repo.name, prNumberHint)
    if (!pr) {
      note(
        'dev',
        `PR #${prNumberHint} not found in ${repo.name} — taking over ${task.issueKey} with a fresh branch instead.`,
        { key: task.issueKey },
        'warn'
      )
    }
  } else {
    pr = await gh.findPrForTask(repo.name, task.issueKey)
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

  if (worktree && repo) {
    await writeAdjacentWorkFile(worktree.path, repo.id)
  }

  const prompt =
    `Additional change request for ${task.issueKey}${task.prNumber ? ` (PR #${task.prNumber})` : ''}:\n\n` +
    `${instructions.trim()}\n\n` +
    `Make these changes in this worktree on branch ${worktree.branch}, commit, and push to update ` +
    `the existing PR. Do NOT open a new PR. ` +
    `When you have committed and pushed everything, signal completion by creating an empty file ` +
    `named ${REVISE_FILE} in this directory (e.g. \`touch ${REVISE_FILE}\`). ` +
    `That file tells the orchestrator the revision is done.\n\n` +
    `Adjacent work context (other active branches and files currently being edited) is available in the git-ignored ADJACENT_WORK.md file. Read it to coordinate and avoid conflicts on shared files.\n`

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

/** Publish a draft PR (auto or user-initiated) → in_review. */
export async function publishDevTask(taskId: number): Promise<void> {
  const task = store.getTask(taskId)
  if (!task || !task.prNumber || !task.repoId) return
  const repo = store.getRepo(task.repoId)
  if (!repo) return
  await gh.publishPr(repo.name, task.prNumber)
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
  await gh.mergePr(repo.name, task.prNumber)
  store.recordEvent('dev.merged', { taskId, prNumber: task.prNumber, via: 'autopilotv' })
  await finishMerged(task)
}

/** PR merged → stop tracking. Prune the worktree; do NOT touch the tracker (QA owns Done). */
async function finishMerged(task: TrackerTask): Promise<void> {
  if (task.sessionId && sessionManager.isLive(task.sessionId)) {
    sessionManager.kill(task.sessionId, 'pr merged')
  }
  if (task.worktreeId) {
    const wt = store.getWorktree(task.worktreeId)
    if (wt && !wt.prunedAt) await pruneWorktree(wt)
  }
  // Completes the task and freezes its current tracker status; if the tracker
  // later moves it back to To Do (a QA bounce), the brain re-queues it (see
  // store.upsertTask reopen detection + brain.refreshWork).
  store.completeTask(task.id)
  note('dev', `PR #${task.prNumber} for ${task.issueKey} merged — done, no longer tracking.`, { key: task.issueKey })
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
  if (task?.worktreeId) {
    const wt = store.getWorktree(task.worktreeId)
    if (wt && !wt.prunedAt) await discardWorktree(wt)
  }
  store.resetTask(taskId)
  store.recordEvent(eventKind, { taskId })
}

/**
 * Advance every in-flight dev task through its lifecycle. Called each tick.
 */
export async function advanceDevTasks(settings: Settings): Promise<void> {
  const tasks = store
    .listTasks()
    .filter((t) => ['implementing', 'draft', 'revising', 'in_review', 'ready_to_merge'].includes(t.phase))

  for (const task of tasks) {
    try {
      await advanceOne(task, settings)
    } catch (err) {
      log.warn('dev advance failed', { taskId: task.id, err: String(err) })
    }
  }
}

async function advanceOne(task: TrackerTask, settings: Settings): Promise<void> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo) return

  if (task.phase === 'implementing') {
    if (!worktree) return
    // Primary signal: the .pr-url file the agent writes. Fallback: query GitHub
    // for an open PR on the branch (in case the agent skipped the file).
    const fromFile = readPrUrlFile(worktree.path)
    const pr = fromFile ?? (await gh.findPrForBranch(repo.name, worktree.branch))
    if (pr) {
      store.setTaskPr(task.id, pr.number, pr.url)
      store.setTaskPhase(task.id, 'draft')
      if (task.sessionId && sessionManager.isLive(task.sessionId)) {
        sessionManager.kill(task.sessionId, 'draft PR opened')
      }
      note('dev', `${task.issueKey} opened draft PR #${pr.number}${fromFile ? ' (via .pr-url)' : ''}.`, {
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
    return
  }

  if (task.phase === 'revising') {
    // The agent writes .revise when done; that's the signal to end the (still
    // interactive) session. Also complete if the session died on its own.
    const reviseFile = worktree ? join(worktree.path, REVISE_FILE) : null
    const signalled = reviseFile ? existsSync(reviseFile) : false
    if (signalled || !isTaskSessionActive(task)) {
      if (reviseFile && signalled) rmSync(reviseFile, { force: true }) // cleanup so the next revision works
      if (task.sessionId && sessionManager.isLive(task.sessionId)) {
        sessionManager.kill(task.sessionId, 'revision complete')
      }
      let next: TrackerTask['phase'] = 'draft'
      if (worktree && task.prNumber) {
        const pr = await gh.findPrForBranch(repo.name, worktree.branch)
        if (pr && pr.isDraft === false) next = 'in_review'
      }
      store.setTaskPhase(task.id, next)
      note(
        'dev',
        `${task.issueKey}: revisions complete — back to ${next === 'in_review' ? 'review' : 'draft'}.`,
        { key: task.issueKey }
      )
    }
    return
  }

  if (task.phase === 'draft') {
    if (settings.autoPublish) {
      await publishDevTask(task.id)
    }
    // else: wait for the user to click Publish.
    return
  }

  if (task.phase === 'in_review' || task.phase === 'ready_to_merge') {
    if (!task.prNumber) return
    const r = await gh.getPrReadiness(repo.name, task.prNumber)

    if (r.state === 'MERGED') {
      await finishMerged(task)
      return
    }
    if (r.state === 'CLOSED') {
      store.completeTask(task.id)
      note('dev', `PR #${task.prNumber} for ${task.issueKey} was closed — no longer tracking.`, {}, 'warn')
      return
    }

    // The address-comments agent writes .address-comments when done — end that
    // (still interactive) session and clean up so the next round can run.
    const addrFile = worktree ? join(worktree.path, ADDRESS_FILE) : null
    if (addrFile && existsSync(addrFile)) {
      rmSync(addrFile, { force: true })
      if (task.sessionId && sessionManager.isLive(task.sessionId)) {
        sessionManager.kill(task.sessionId, 'comments addressed')
      }
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
        if (task.sessionId && sessionManager.isLive(task.sessionId)) {
          sessionManager.kill(task.sessionId, 'ready to merge')
        }
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
}

async function startAddressComments(
  task: TrackerTask,
  repo: Repo,
  worktree: { path: string; id: number } | null
): Promise<void> {
  if (!worktree) return
  const harness = store.getCodingHarness()
  if (!harness) return

  await writeAdjacentWorkFile(worktree.path, repo.id)

  const prompt =
    `Reviewers left feedback on PR #${task.prNumber} (${repo.name}).\n` +
    `Read the unresolved review comments (e.g. \`gh pr view ${task.prNumber} --comments\`), ` +
    `address them in this worktree, commit, and push to the same branch. ` +
    `Reply to or resolve threads where appropriate. ` +
    `When you have committed and pushed all fixes, signal completion by creating an empty file ` +
    `named ${ADDRESS_FILE} in this directory (e.g. \`touch ${ADDRESS_FILE}\`). ` +
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
