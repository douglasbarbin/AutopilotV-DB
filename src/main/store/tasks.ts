import { getDb } from './_db'
import { log } from '../log'
import type { TrackerTask, TaskStatus, DevPhase } from '@shared/types/domain'

interface TaskRow {
  id: number
  issue_key: string
  project_key: string | null
  title: string
  status: TaskStatus
  tracker_status: string
  assignee: string | null
  priority: number
  issue_type: string | null
  sprint: string | null
  phase: DevPhase
  pr_number: number | null
  pr_url: string
  repo_id: number | null
  worktree_id: number | null
  claim_state: string
  session_id: number | null
  updated_at: string
  done_tracker_status: string
  verified_sha: string
  addressed_sha: string
}

function rowToTask(r: TaskRow): TrackerTask {
  return {
    id: r.id,
    issueKey: r.issue_key,
    projectKey: r.project_key ?? (r.issue_key?.split('-')[0] ?? ''),
    title: r.title,
    status: r.status,
    trackerStatus: r.tracker_status ?? 'To Do',
    assignee: r.assignee ?? '',
    priority: r.priority,
    issueType: r.issue_type ?? 'Story',
    sprint: r.sprint ?? '',
    phase: r.phase ?? 'unclaimed',
    prNumber: r.pr_number ?? null,
    prUrl: r.pr_url ?? '',
    repoId: r.repo_id ?? null,
    worktreeId: r.worktree_id ?? null,
    claimState: r.claim_state as TrackerTask['claimState'],
    sessionId: r.session_id,
    updatedAt: r.updated_at,
    verifiedSha: r.verified_sha ?? '',
    addressedSha: r.addressed_sha ?? ''
  }
}

export function upsertTask(t: {
  issueKey: string
  title: string
  status?: TaskStatus
  trackerStatus?: string
  assignee?: string
  priority?: number
  issueType?: string
  sprint?: string
  projectKey?: string
}): { id: number; reopened: boolean } {
  const db = getDb()
  // Detect a reopen BEFORE the write: a task we'd already finished that the
  // tracker now shows back in a To-Do state, under a status string different from
  // the one it carried at completion. The status-change guard prevents a freshly
  // merged task (whose tracker status simply lags) from being re-queued at once.
  const prev = db
    .prepare('SELECT id, phase, done_tracker_status FROM tasks WHERE issue_key = ?')
    .get(t.issueKey) as { id: number; phase: string; done_tracker_status: string } | undefined
  const incomingStatus = t.status ?? 'todo'
  const incomingTrackerStatus = t.trackerStatus ?? 'To Do'
  const reopened =
    !!prev &&
    prev.phase === 'done' &&
    incomingStatus === 'todo' &&
    incomingTrackerStatus !== prev.done_tracker_status

  db.prepare(
    `INSERT INTO tasks (issue_key, project_key, title, status, tracker_status, assignee, priority, issue_type, sprint)
       VALUES (@issue_key, @project_key, @title, @status, @tracker_status, @assignee, @priority, @issue_type, @sprint)
       ON CONFLICT(issue_key) DO UPDATE SET
         title = @title, assignee = @assignee, priority = @priority, project_key = @project_key,
         status = @status, tracker_status = @tracker_status,
         issue_type = @issue_type, sprint = @sprint, updated_at = datetime('now')`
  ).run({
    issue_key: t.issueKey,
    project_key: t.projectKey ?? t.issueKey.split('-')[0] ?? '',
    title: t.title,
    status: incomingStatus,
    tracker_status: incomingTrackerStatus,
    assignee: t.assignee ?? null,
    priority: t.priority ?? 3,
    issue_type: t.issueType ?? 'Story',
    sprint: t.sprint ?? ''
  })
  const id =
    prev?.id ??
    (db.prepare('SELECT id FROM tasks WHERE issue_key = ?').get(t.issueKey) as { id: number }).id
  return { id, reopened }
}

/**
 * Mark a dev task finished and freeze the tracker status it had at that moment.
 * The frozen status is what lets a later move back to To Do (e.g. a QA bounce)
 * read as a genuine reopen rather than the post-merge status lag.
 */
export function completeTask(id: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET phase = 'done', claim_state = 'done', done_tracker_status = tracker_status,
       session_id = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(id)
}

export function listTasks(): TrackerTask[] {
  const rows = getDb()
    .prepare('SELECT * FROM tasks ORDER BY priority DESC, updated_at DESC')
    .all() as TaskRow[]
  return rows.map(rowToTask)
}

export function getTask(id: number): TrackerTask | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToTask(row) : null
}

/** Epics are not actionable work items — remove any that slipped into the table. */
export function purgeEpicTasks(): number {
  const info = getDb().prepare("DELETE FROM tasks WHERE lower(issue_type) = 'epic'").run()
  if (info.changes > 0) log.info('purged epic tasks', { count: info.changes })
  return info.changes
}

export function setTaskStatus(id: number, status: TaskStatus): void {
  getDb()
    .prepare("UPDATE tasks SET status = ?, updated_at = datetime('now') WHERE id = ?")
    .run(status, id)
}

export function setTaskPhase(id: number, phase: DevPhase): void {
  getDb()
    .prepare("UPDATE tasks SET phase = ?, updated_at = datetime('now') WHERE id = ?")
    .run(phase, id)
}

export function setTaskPr(id: number, prNumber: number, prUrl: string): void {
  getDb().prepare('UPDATE tasks SET pr_number = ?, pr_url = ? WHERE id = ?').run(prNumber, prUrl, id)
}

export function setTaskRepo(id: number, repoId: number): void {
  getDb().prepare('UPDATE tasks SET repo_id = ? WHERE id = ?').run(repoId, id)
}

export function setTaskWorktree(id: number, worktreeId: number): void {
  getDb().prepare('UPDATE tasks SET worktree_id = ? WHERE id = ?').run(worktreeId, id)
}

/** Record the commit SHA last run through the verification gate (theme B). */
export function setTaskVerifiedSha(id: number, sha: string): void {
  getDb().prepare('UPDATE tasks SET verified_sha = ? WHERE id = ?').run(sha, id)
}

/** Record the PR head commit at which review feedback was last addressed. */
export function setTaskAddressedSha(id: number, sha: string): void {
  getDb().prepare('UPDATE tasks SET addressed_sha = ? WHERE id = ?').run(sha, id)
}

/** Reset a dev task back to unclaimed so it can be retried from scratch. */
export function resetTask(id: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET phase = 'unclaimed', claim_state = 'unclaimed', lease_owner = NULL,
       lease_expires_at = NULL, session_id = NULL, worktree_id = NULL, repo_id = NULL,
       pr_number = NULL, pr_url = '', done_tracker_status = '', verified_sha = '',
       addressed_sha = '', updated_at = datetime('now') WHERE id = ?`
    )
    .run(id)
}
