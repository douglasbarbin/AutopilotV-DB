/**
 * Independent verification (theme B). Before a dev task is surfaced as
 * ready_to_merge, AutopilotV runs the repo's own test/build command in the
 * task's worktree (which sits on the pushed branch) and, advisory-only, asks
 * the brain LLM whether the diff plausibly implements the ticket. The command
 * result GATES promotion; the spec check is recorded and shown but never blocks.
 *
 * Re-run safety: a commit is verified at most once (tracked via tasks.verified_sha),
 * so a satisfied forge gate doesn't re-run the suite every tick — only a new
 * pushed commit (a fresh SHA) triggers another pass.
 */
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { log } from '../log'
import * as store from '../store'
import { exec, execShell } from '../util/exec'
import { forgeForRepo } from '../forges'
import { tickState } from '../brain/tickState'
import { makeProvider, judgeValidated, SpecConformanceSchema } from '../llm/provider'
import type { Repo, Settings, TrackerTask, Worktree, TaskVerification } from '@shared/types/domain'

export interface VerifyOutcome {
  status: TaskVerification['status']
  summary: string
  detail: Record<string, unknown>
}

/** Resolve the worktree's current HEAD commit, or '' if it can't be read. */
export async function currentSha(worktreePath: string): Promise<string> {
  const r = await exec('git', ['rev-parse', 'HEAD'], { cwd: worktreePath })
  return r.code === 0 ? r.stdout.trim() : ''
}

/**
 * Auto-detect a sensible default verify command from the repo's contents when
 * the operator hasn't configured one. Intentionally minimal — returns null
 * (verification skipped) rather than guessing aggressively.
 */
export function detectVerifyCommand(repoPath: string | null): string | null {
  if (!repoPath) return null
  const pkgPath = join(repoPath, 'package.json')
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> }
      const scripts = pkg.scripts ?? {}
      const test = scripts.test
      if (test && !/no test specified/i.test(test)) return 'npm test'
      if (scripts.build) return 'npm run build'
    } catch {
      /* unreadable package.json — fall through */
    }
  }
  return null
}

/** Run the repo's verify command in the worktree. Command failure → status 'fail'. */
export async function runCommandVerification(
  repo: Repo,
  worktree: Worktree,
  settings: Settings
): Promise<VerifyOutcome> {
  const command = (repo.verifyCommand?.trim() || detectVerifyCommand(repo.path)) ?? ''
  if (!command) {
    return { status: 'skipped', summary: 'No verify command configured or auto-detected.', detail: {} }
  }
  if (!existsSync(worktree.path)) {
    return { status: 'error', summary: 'Worktree is gone — cannot verify.', detail: { command } }
  }
  const r = await execShell(command, {
    cwd: worktree.path,
    timeoutMs: Math.max(30, settings.verifyTimeoutSeconds) * 1000
  })
  const output = `${r.stdout}\n${r.stderr}`.slice(-4000)
  const status: VerifyOutcome['status'] = r.code === 0 ? 'pass' : 'fail'
  return {
    status,
    summary: `\`${command}\` → exit ${r.code}`,
    detail: { command, exitCode: r.code, output }
  }
}

/** Advisory LLM check: does the PR diff plausibly implement the ticket? */
export async function runSpecConformance(
  task: TrackerTask,
  repo: Repo,
  settings: Settings
): Promise<VerifyOutcome> {
  if (!task.prNumber) return { status: 'skipped', summary: 'No PR to compare.', detail: {} }
  let diff = ''
  try {
    const { forge, config } = forgeForRepo(repo, settings)
    diff = (await forge.getPrDiff(repo.name, task.prNumber, config)).slice(0, 30_000)
  } catch (err) {
    return { status: 'error', summary: `Couldn't fetch diff: ${String(err).slice(0, 120)}`, detail: {} }
  }
  try {
    const provider = makeProvider(settings)
    const result = await judgeValidated(
      provider,
      {
        schemaName: 'SpecConformance',
        system:
          'You are a senior engineer judging whether a pull request diff plausibly implements the ' +
          'work item it claims to. Be skeptical but fair. Flag missing pieces, scope drift, and ' +
          'obvious gaps as concerns. This is advisory only.',
        user:
          `Work item ${task.issueKey}: ${task.title}\n\n` +
          `Unified diff of the PR:\n\n${diff}\n\n` +
          'Respond with {conforms, confidence (low|medium|high), concerns: string[], summary}.'
      },
      SpecConformanceSchema
    )
    return {
      status: result.conforms ? 'pass' : 'fail',
      summary: result.summary.slice(0, 400),
      detail: { confidence: result.confidence, concerns: result.concerns }
    }
  } catch (err) {
    return { status: 'error', summary: `Spec check failed: ${String(err).slice(0, 120)}`, detail: {} }
  }
}

export interface MergeVerificationResult {
  /** Whether promotion to ready_to_merge is allowed (command did not fail). */
  ok: boolean
  /** True while this commit's verification is queued or running in the
   *  background — not a verdict; check again next tick. */
  pending?: boolean
  /** Present only when this commit's verification failed. */
  failureSummary?: string
  /** Pipeline stage that failed ('secrets' is operator-fixable, not agent-fixable). */
  failureStage?: string
}

/** Reconstruct the failure detail callers feed the fix-session prompt from a
 *  persisted verdict row (pipeline rollups carry failedStage/failureSummary;
 *  command rows carry command/output). */
export function failureFromVerdict(v: TaskVerification): { failureSummary: string; failureStage?: string } {
  const d = v.detail as { failedStage?: string; failureSummary?: string; output?: string }
  return {
    failureStage: d.failedStage,
    failureSummary:
      d.failureSummary ?? `${v.summary}${d.output ? `\n\n${String(d.output).slice(-2000)}` : ''}`
  }
}

/**
 * Verify a task at its current commit and decide whether it may be promoted to
 * ready_to_merge. Returns ok=true (non-blocking) for skipped/error/already-verified
 * commits; ok=false only when this commit's verification failed — or, with
 * pending=true, while the verification job is still running in the background.
 *
 * The heavy work (pipeline / command run / spec check) does NOT run here: it
 * is enqueued on the verification queue so a multi-minute pipeline never
 * blocks the brain tick. The verdict lands in task_verifications and the
 * verified-SHA cache; the next tick reads it through the cached path below.
 */
export async function verifyTaskForMerge(
  task: TrackerTask,
  settings: Settings
): Promise<MergeVerificationResult> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null
  if (!repo || !worktree || worktree.prunedAt) {
    return { ok: true } // nothing to verify against — don't block
  }

  const sha = await currentSha(worktree.path)
  if (!sha) {
    return { ok: true } // couldn't read HEAD; don't deadlock the task
  }

  // Already verified this exact commit: return the cached verdict.
  if (sha === task.verifiedSha) {
    const last = store
      .listVerificationsForTask(task.id)
      .find((v) => (v.kind === 'command' || v.kind === 'pipeline') && v.commitSha === sha)
    if (!last || last.status !== 'fail') return { ok: true }
    return { ok: false, ...failureFromVerdict(last) }
  }

  // Fresh commit → queue the gating verification and report pending.
  const { isVerificationPending, enqueueVerification } = await import('./verifyQueue')
  const key = `verify:${task.id}:merge_gate:${sha}`
  if (!isVerificationPending(key)) {
    store.recordBrainNote({
      tick: tickState.current,
      category: 'dev',
      message: `${task.issueKey}: merge-gate verification queued for ${sha.slice(0, 7)} — running in the background.`,
      detail: { key: task.issueKey }
    })
    enqueueVerification(key, () => runMergeVerification(task, repo, worktree, settings, sha))
  }
  return { ok: false, pending: true }
}

/**
 * The heavy half of the merge gate, run on the background verification queue.
 * Persists the gate verdict (pipeline rollup or command row), the advisory
 * spec check, and the verified-SHA marker that the cached path reads.
 */
async function runMergeVerification(
  task: TrackerTask,
  repo: Repo,
  worktree: Worktree,
  settings: Settings,
  sha: string
): Promise<void> {
  // When the repo declares runbook stages, the staged pipeline replaces the
  // single command; the merge gate skips the full pipeline when the draft
  // checkpoint already proved this exact SHA.
  const { runPipeline, hasRunbookStages, verdictIsCurrent } = await import('./pipeline')
  if (hasRunbookStages(repo)) {
    const draftPass = store.getPipelineVerdict(task.id, 'draft', sha)
    if (draftPass?.status === 'pass' && verdictIsCurrent(repo, draftPass)) {
      store.insertVerification({
        taskId: task.id,
        prNumber: task.prNumber,
        commitSha: sha,
        kind: 'pipeline',
        status: 'pass',
        summary: 'proven at the draft checkpoint (same commit) — full pipeline not re-run',
        detail: { via: 'draft' },
        checkpoint: 'merge_gate'
      })
    } else {
      await runPipeline(task, repo, worktree, settings, 'merge_gate', sha)
    }
  } else {
    const cmd = await runCommandVerification(repo, worktree, settings)
    store.insertVerification({
      taskId: task.id,
      prNumber: task.prNumber,
      commitSha: sha,
      kind: 'command',
      status: cmd.status,
      summary: cmd.summary,
      detail: cmd.detail,
      checkpoint: 'merge_gate'
    })
    if (cmd.status === 'fail') {
      store.recordEvent('dev.verify_failed', { taskId: task.id, prNumber: task.prNumber, sha }, { level: 'warn' })
      log.warn('verification failed', { taskId: task.id, summary: cmd.summary })
    }
  }

  if (settings.verifySpecConformance) {
    const spec = await runSpecConformance(task, repo, settings)
    store.insertVerification({
      taskId: task.id,
      prNumber: task.prNumber,
      commitSha: sha,
      kind: 'spec',
      status: spec.status,
      summary: spec.summary,
      detail: spec.detail,
      checkpoint: 'merge_gate'
    })
  }

  store.setTaskVerifiedSha(task.id, sha)
}
