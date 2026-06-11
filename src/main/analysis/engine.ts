import { z } from 'zod'
import { existsSync } from 'fs'
import { log } from '../log'
import * as store from '../store'
import { exec } from '../util/exec'
import { forgeForRepo } from '../forges'
import { judgeValidated, makeProvider } from '../llm/provider'
import { tickState } from '../brain/tickState'
import {
  SignalFollowUpSchema,
  SignalLearningSchema,
  type SignalReport
} from '../worktree/signals'
import type { Settings, TrackerTask } from '@shared/types/domain'

/**
 * Post-implementation analysis engine.
 *
 * Two entry points, both deterministic-first with one optional schema-validated
 * LLM distillation — never an agent session:
 *
 *  - harvestSignalReport: when a phase consumes a v2 signal carrying a report,
 *    the agent-authored followUps/learnings go straight into the insights
 *    store. No LLM involved; the agent already structured them.
 *
 *  - runPostMergeAnalysis: when a dev task's PR merges, mine what the lifecycle
 *    left behind — TODO/FIXME lines the change introduced (from the worktree
 *    diff, scanned before the worktree is pruned), the PR conversation, and
 *    verification failures — and distill follow-ups + learnings out of it with
 *    a single judgment call. The deterministic TODO harvest happens even when
 *    no LLM is reachable.
 */

export function harvestSignalReport(
  task: TrackerTask,
  report: SignalReport,
  source = 'signal'
): { followUps: number; learnings: number } {
  let followUps = 0
  let learnings = 0
  for (const f of report.followUps) {
    const id = store.insertFollowUp({
      taskId: task.id,
      issueKey: task.issueKey,
      repoId: task.repoId,
      projectKey: task.projectKey,
      title: f.title,
      description: f.description,
      kind: f.kind,
      priority: f.priority,
      files: f.files,
      source
    })
    if (id !== null) followUps++
  }
  for (const l of report.learnings) {
    const id = store.insertKnowledge({
      repoId: task.repoId,
      projectKey: task.projectKey,
      role: l.role,
      insight: l.insight,
      evidence: l.evidence,
      confidence: l.confidence,
      source
    })
    if (id !== null) learnings++
  }
  return { followUps, learnings }
}

const AnalysisResultSchema = z.object({
  followUps: z.array(SignalFollowUpSchema).catch([]),
  learnings: z.array(SignalLearningSchema).catch([])
})

/** Added TODO/FIXME/HACK lines in the task's diff, with the file they're in. */
export async function scanDiffForTodos(
  worktreePath: string,
  baseBranch: string
): Promise<{ file: string; line: string }[]> {
  const r = await exec('git', ['diff', `origin/${baseBranch}...HEAD`], { cwd: worktreePath, timeoutMs: 20_000 })
  if (r.code !== 0) return []
  const found: { file: string; line: string }[] = []
  let file = ''
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      continue
    }
    if (line.startsWith('+') && !line.startsWith('+++') && /\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
      found.push({ file, line: line.slice(1).trim().slice(0, 200) })
      if (found.length >= 20) break
    }
  }
  return found
}

export async function runPostMergeAnalysis(task: TrackerTask, settings: Settings): Promise<void> {
  const repo = task.repoId ? store.getRepo(task.repoId) : null
  if (!repo) return
  const worktree = task.worktreeId ? store.getWorktree(task.worktreeId) : null

  // 1. Deterministic harvest: TODO/FIXME lines this change introduced become
  //    follow-ups directly — no LLM needed for what's literally in the diff.
  let todos: { file: string; line: string }[] = []
  if (worktree && !worktree.prunedAt && existsSync(worktree.path)) {
    try {
      todos = await scanDiffForTodos(worktree.path, repo.defaultBranch)
    } catch (err) {
      log.warn('post-merge TODO scan failed', { taskId: task.id, err: String(err) })
    }
  }
  let harvested = 0
  for (const t of todos) {
    const id = store.insertFollowUp({
      taskId: task.id,
      issueKey: task.issueKey,
      repoId: repo.id,
      projectKey: task.projectKey,
      title: `Address ${t.line.slice(0, 80)}`,
      description: `Left in ${t.file} by ${task.issueKey}: ${t.line}`,
      kind: 'todo',
      priority: 'low',
      files: t.file ? [t.file] : [],
      source: 'analysis'
    })
    if (id !== null) harvested++
  }

  // 2. Gather conversational + lifecycle material for the distillation pass.
  let comments: { author: string; body: string }[] = []
  if (task.prNumber) {
    try {
      const { forge, config } = forgeForRepo(repo, settings)
      comments = (await forge.listPrComments?.(repo.name, task.prNumber, config)) ?? []
    } catch (err) {
      log.warn('post-merge comment fetch failed', { taskId: task.id, err: String(err) })
    }
  }
  const failures = store
    .listVerificationsForTask(task.id)
    .filter((v) => v.status === 'fail' || v.status === 'error')
    .map((v) => `${v.kind}: ${v.summary}`)
  const reports = store
    .listEvents(500)
    .filter((e) => e.kind === 'signal.report' && (e.payload as { taskId?: number }).taskId === task.id)
    .map((e) => e.payload as { phase?: string; summary?: string; deviations?: string })

  const material = [
    comments.length
      ? `PR conversation:\n${comments.map((c) => `${c.author}: ${c.body}`).join('\n---\n').slice(0, 4000)}`
      : '',
    failures.length ? `Verification failures during the run:\n${failures.join('\n').slice(0, 1500)}` : '',
    reports.length
      ? `Agent self-reports:\n${reports
          .map((r) => `[${r.phase}] ${r.summary ?? ''}${r.deviations ? ` | deviations: ${r.deviations}` : ''}`)
          .join('\n')
          .slice(0, 2000)}`
      : ''
  ]
    .filter(Boolean)
    .join('\n\n')

  // 3. One schema-validated LLM distillation, only when there is material.
  //    Degrades silently to the deterministic harvest when no LLM is reachable.
  let distilled = { followUps: 0, learnings: 0 }
  if (material) {
    try {
      const provider = makeProvider(settings)
      const result = await judgeValidated<z.infer<typeof AnalysisResultSchema>>(
        provider,
        {
          schemaName: 'PostMergeAnalysis',
          system:
            'You are doing post-merge analysis for an autonomous dev pipeline. From the material, extract:\n' +
            '- followUps: concrete future work items (deferred fixes, tech debt, missing tests, reviewer asks that were postponed). Short imperative titles. Do NOT restate work that was completed.\n' +
            '- learnings: durable, repo-specific conventions or gotchas that future coding/review agents should know (e.g. "this repo requires X before Y"). Max 3; prefer none over generic advice.\n' +
            'kind is one of todo|tech_debt|bug|enhancement|test_gap; priority low|medium|high; role coding|review; confidence low|medium|high.',
          user:
            `Task ${task.issueKey}: ${task.title}\nRepo: ${repo.name}\n\n${material}\n\n` +
            'Respond as JSON: {"followUps":[{"title":string,"description":string,"kind":string,"priority":string,"files":string[]}],"learnings":[{"role":string,"insight":string,"evidence":string,"confidence":string}]}'
        },
        AnalysisResultSchema
      )
      distilled = harvestSignalReport(task, { version: 1, summary: '', deviations: '', ...result }, 'analysis')
    } catch (err) {
      log.warn('post-merge distillation failed; keeping deterministic harvest', {
        taskId: task.id,
        err: String(err)
      })
    }
  }

  store.recordEvent('analysis.completed', {
    taskId: task.id,
    issueKey: task.issueKey,
    todosFound: todos.length,
    followUps: harvested + distilled.followUps,
    learnings: distilled.learnings,
    minedComments: comments.length
  })
  const total = harvested + distilled.followUps + distilled.learnings
  if (total > 0) {
    store.recordBrainNote({
      tick: tickState.current,
      category: 'dev',
      message: `Post-merge analysis of ${task.issueKey}: ${harvested + distilled.followUps} follow-up(s) and ${distilled.learnings} learning(s) queued for your review in Backlog & Insights.`,
      detail: { taskId: task.id }
    })
  }
}
