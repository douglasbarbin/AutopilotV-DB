/**
 * Verification verdicts (theme B). Each row is one dimension's result for a dev
 * task at a specific commit: the `command` verification (ran the repo's
 * test/build command) or the advisory `spec` check (LLM diff-vs-ticket).
 */
import { getDb } from './_db'
import type { TaskVerification } from '@shared/types/domain'

interface VerificationRow {
  id: number
  task_id: number
  pr_number: number | null
  commit_sha: string
  kind: TaskVerification['kind']
  status: TaskVerification['status']
  summary: string
  detail_json: string
  checkpoint: TaskVerification['checkpoint']
  created_at: string
}

function rowToVerification(r: VerificationRow): TaskVerification {
  let detail: Record<string, unknown> = {}
  try {
    detail = JSON.parse(r.detail_json) as Record<string, unknown>
  } catch {
    /* leave empty */
  }
  return {
    id: r.id,
    taskId: r.task_id,
    prNumber: r.pr_number,
    commitSha: r.commit_sha,
    kind: r.kind,
    status: r.status,
    summary: r.summary,
    detail,
    checkpoint: r.checkpoint ?? 'commit',
    createdAt: r.created_at
  }
}

export function insertVerification(v: {
  taskId: number
  prNumber: number | null
  commitSha: string
  kind: TaskVerification['kind']
  status: TaskVerification['status']
  summary: string
  detail?: Record<string, unknown>
  checkpoint?: TaskVerification['checkpoint']
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO task_verifications (task_id, pr_number, commit_sha, kind, status, summary, detail_json, checkpoint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.taskId,
      v.prNumber,
      v.commitSha,
      v.kind,
      v.status,
      v.summary,
      JSON.stringify(v.detail ?? {}),
      v.checkpoint ?? 'commit'
    )
  return Number(info.lastInsertRowid)
}

/** The synthetic pipeline rollup for (task, checkpoint, sha), or null. */
export function getPipelineVerdict(
  taskId: number,
  checkpoint: TaskVerification['checkpoint'],
  commitSha: string
): TaskVerification | null {
  const row = getDb()
    .prepare(
      `SELECT * FROM task_verifications
       WHERE task_id = ? AND checkpoint = ? AND commit_sha = ? AND kind = 'pipeline'
       ORDER BY id DESC LIMIT 1`
    )
    .get(taskId, checkpoint, commitSha) as VerificationRow | undefined
  return row ? rowToVerification(row) : null
}

export function listVerificationsForTask(taskId: number): TaskVerification[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_verifications WHERE task_id = ? ORDER BY id DESC')
    .all(taskId) as VerificationRow[]
  return rows.map(rowToVerification)
}

/**
 * Retention sweep: drop old verdicts for FINISHED tasks only. In-flight tasks
 * keep their full history — the verdict-by-SHA cache is what lets a tick skip
 * re-running a pipeline, so pruning those would cause spurious re-verification.
 */
export function pruneVerifications(days = 30): number {
  const info = getDb()
    .prepare(
      `DELETE FROM task_verifications
       WHERE created_at < datetime('now', ?)
         AND task_id IN (SELECT id FROM tasks WHERE phase = 'done')`
    )
    .run(`-${days} days`)
  return info.changes
}

/**
 * Latest verification per (task, kind) — what the WorkQueue renders as a badge.
 * Bounded to keep the AppState push small; reviews/tasks are dozens, not thousands.
 */
export function listRecentVerifications(limit = 200): TaskVerification[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM task_verifications WHERE id IN (
         SELECT MAX(id) FROM task_verifications GROUP BY task_id, kind
       ) ORDER BY id DESC LIMIT ?`
    )
    .all(limit) as VerificationRow[]
  return rows.map(rowToVerification)
}
