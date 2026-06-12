import { getDb } from './_db'
import { getSettings } from './settings'
import type { Session, SessionStatus, WorkKind } from '@shared/types/domain'

interface SessionRow {
  id: number
  kind: WorkKind
  work_ref: string
  harness_id: string
  worktree_id: number | null
  pid: number | null
  status: SessionStatus
  auto_drive: number
  auto_inject_count: number
  last_output_at: string | null
  title: string
  started_at: string
  exited_at: string | null
  exit_reason: string | null
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    kind: r.kind,
    workRef: r.work_ref,
    harnessId: r.harness_id,
    worktreeId: r.worktree_id,
    pid: r.pid,
    status: r.status,
    autoDrive: !!r.auto_drive,
    autoInjectCount: r.auto_inject_count,
    lastOutputAt: r.last_output_at,
    startedAt: r.started_at,
    exitedAt: r.exited_at,
    exitReason: r.exit_reason,
    title: r.title
  }
}

export function createSession(s: {
  kind: WorkKind
  workRef: string
  harnessId: string
  worktreeId: number | null
  title: string
  autoDrive?: boolean
}): number {
  // Default to the global auto-drive setting if not specified.
  const autoDrive = s.autoDrive ?? getSettings().autoDrive.enabled
  const info = getDb()
    .prepare(
      `INSERT INTO sessions (kind, work_ref, harness_id, worktree_id, title, status, auto_drive)
       VALUES (?, ?, ?, ?, ?, 'starting', ?)`
    )
    .run(s.kind, s.workRef, s.harnessId, s.worktreeId, s.title, autoDrive ? 1 : 0)
  return Number(info.lastInsertRowid)
}

export function setSessionAutoDrive(id: number, enabled: boolean): void {
  getDb().prepare('UPDATE sessions SET auto_drive = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function setSessionPid(id: number, pid: number): void {
  getDb().prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(pid, id)
}

export function setSessionStatus(id: number, status: SessionStatus, exitReason?: string): void {
  const terminal = status === 'exited' || status === 'killed'
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?, exit_reason = COALESCE(?, exit_reason),
       exited_at = CASE WHEN ? THEN datetime('now') ELSE exited_at END WHERE id = ?`
    )
    .run(status, exitReason ?? null, terminal ? 1 : 0, id)
}

export function markSessionOutput(id: number): void {
  getDb()
    .prepare("UPDATE sessions SET last_output_at = datetime('now') WHERE id = ?")
    .run(id)
}

export function incrementInject(id: number): number {
  getDb()
    .prepare('UPDATE sessions SET auto_inject_count = auto_inject_count + 1 WHERE id = ?')
    .run(id)
  return (
    getDb().prepare('SELECT auto_inject_count AS c FROM sessions WHERE id = ?').get(id) as {
      c: number
    }
  ).c
}

export function getSession(id: number): Session | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as
    | SessionRow
    | undefined
  return row ? rowToSession(row) : null
}

/** Live sessions plus a 24h tail of finished ones — the UI only renders live
 *  sessions, so ancient exited rows have no reason to ride every state push. */
export function listSessions(): Session[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM sessions
       WHERE status IN ('starting','running','stalled','needs_human')
          OR started_at >= datetime('now', '-1 day')
       ORDER BY started_at DESC`
    )
    .all() as SessionRow[]
  return rows.map(rowToSession)
}

export function listActiveSessions(): Session[] {
  const rows = getDb()
    .prepare("SELECT * FROM sessions WHERE status IN ('starting','running','stalled','needs_human')")
    .all() as SessionRow[]
  return rows.map(rowToSession)
}

export function countActiveSessions(): number {
  return (
    getDb()
      .prepare(
        "SELECT COUNT(*) AS c FROM sessions WHERE status IN ('starting','running','stalled','needs_human')"
      )
      .get() as { c: number }
  ).c
}
