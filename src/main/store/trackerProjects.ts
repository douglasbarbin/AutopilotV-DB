import { getDb } from './_db'
import type { TrackerProject } from '@shared/types/domain'

interface TrackerProjectRow {
  key: string
  name: string
  enabled: number
  repo_name: string | null
}

/** Record that a project was seen (keeps the existing enabled flag). */
export function upsertTrackerProjectSeen(key: string, name: string): void {
  if (!key) return
  getDb()
    .prepare(
      `INSERT INTO tracker_projects (key, name) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET name = excluded.name`
    )
    .run(key, name || key)
}

export function listTrackerProjects(): TrackerProject[] {
  const rows = getDb()
    .prepare('SELECT * FROM tracker_projects ORDER BY key')
    .all() as TrackerProjectRow[]
  return rows.map((r) => ({
    key: r.key,
    name: r.name,
    enabled: !!r.enabled,
    repoName: r.repo_name ?? '',
    openCount: (
      getDb()
        .prepare("SELECT COUNT(*) AS c FROM tasks WHERE project_key = ? AND status != 'done'")
        .get(r.key) as { c: number }
    ).c
  }))
}

export function setTrackerProjectEnabled(key: string, enabled: boolean): void {
  getDb().prepare('UPDATE tracker_projects SET enabled = ? WHERE key = ?').run(enabled ? 1 : 0, key)
}

export function setTrackerProjectRepo(key: string, repoName: string): void {
  getDb().prepare('UPDATE tracker_projects SET repo_name = ? WHERE key = ?').run(repoName, key)
}

export function isProjectEnabled(key: string): boolean {
  const row = getDb()
    .prepare('SELECT enabled FROM tracker_projects WHERE key = ?')
    .get(key) as { enabled: number } | undefined
  // Unknown projects default to enabled (they've just been discovered).
  return row ? !!row.enabled : true
}
