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
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO task_verifications (task_id, pr_number, commit_sha, kind, status, summary, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.taskId, v.prNumber, v.commitSha, v.kind, v.status, v.summary, JSON.stringify(v.detail ?? {}))
  return Number(info.lastInsertRowid)
}

export function listVerificationsForTask(taskId: number): TaskVerification[] {
  const rows = getDb()
    .prepare('SELECT * FROM task_verifications WHERE task_id = ? ORDER BY id DESC')
    .all(taskId) as VerificationRow[]
  return rows.map(rowToVerification)
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
