import { getDb } from './_db'
import type { Worktree, WorkKind } from '@shared/types/domain'

interface WorktreeRow {
  id: number
  path: string
  repo_id: number
  branch: string
  kind: WorkKind
  session_id: number | null
  created_at: string
  pruned_at: string | null
}

function rowToWorktree(r: WorktreeRow): Worktree {
  return {
    id: r.id,
    path: r.path,
    repoId: r.repo_id,
    branch: r.branch,
    kind: r.kind,
    sessionId: r.session_id,
    createdAt: r.created_at,
    prunedAt: r.pruned_at
  }
}

export function createWorktree(w: {
  path: string
  repoId: number
  branch: string
  kind: WorkKind
  sessionId: number | null
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO worktrees (path, repo_id, branch, kind, session_id) VALUES (?, ?, ?, ?, ?)`
    )
    .run(w.path, w.repoId, w.branch, w.kind, w.sessionId)
  return Number(info.lastInsertRowid)
}

export function attachWorktreeSession(worktreeId: number, sessionId: number): void {
  getDb().prepare('UPDATE worktrees SET session_id = ? WHERE id = ?').run(sessionId, worktreeId)
  getDb().prepare('UPDATE sessions SET worktree_id = ? WHERE id = ?').run(worktreeId, sessionId)
}

export function getWorktree(id: number): Worktree | null {
  const row = getDb().prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as
    | WorktreeRow
    | undefined
  return row ? rowToWorktree(row) : null
}

export function listWorktrees(): Worktree[] {
  const rows = getDb()
    .prepare('SELECT * FROM worktrees ORDER BY created_at DESC')
    .all() as WorktreeRow[]
  return rows.map(rowToWorktree)
}

export function listLiveWorktrees(): Worktree[] {
  const rows = getDb()
    .prepare('SELECT * FROM worktrees WHERE pruned_at IS NULL')
    .all() as WorktreeRow[]
  return rows.map(rowToWorktree)
}

export function markWorktreePruned(id: number): void {
  getDb().prepare("UPDATE worktrees SET pruned_at = datetime('now') WHERE id = ?").run(id)
}
