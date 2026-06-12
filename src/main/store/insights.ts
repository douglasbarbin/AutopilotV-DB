import { createHash } from 'crypto'
import { getDb } from './_db'
import type {
  FollowUp,
  FollowUpKind,
  FollowUpStatus,
  KnowledgeItem,
  KnowledgeRole,
  KnowledgeStatus
} from '@shared/types/domain'

/**
 * Store for the post-implementation analysis output: follow-up work items
 * (candidate backlog stories) and learned knowledge (insights injected into
 * future sessions). Both tables dedupe on a content hash so re-harvesting the
 * same material (signal report + post-merge analysis) inserts once.
 */

function dedupeHash(...parts: (string | number | null)[]): string {
  const norm = parts
    .map((p) =>
      String(p ?? '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim()
    )
    .join('|')
  return createHash('sha1').update(norm).digest('hex')
}

// ---- followups ----

interface FollowUpRow {
  id: number
  task_id: number | null
  issue_key: string
  repo_id: number | null
  project_key: string
  title: string
  description: string
  kind: FollowUpKind
  priority: 'low' | 'medium' | 'high'
  files_json: string
  source: string
  status: FollowUpStatus
  created_issue_key: string
  created_at: string
  updated_at: string
}

function rowToFollowUp(r: FollowUpRow): FollowUp {
  return {
    id: r.id,
    taskId: r.task_id,
    issueKey: r.issue_key,
    repoId: r.repo_id,
    projectKey: r.project_key,
    title: r.title,
    description: r.description,
    kind: r.kind,
    priority: r.priority,
    files: JSON.parse(r.files_json),
    source: r.source,
    status: r.status,
    createdIssueKey: r.created_issue_key,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function insertFollowUp(f: {
  taskId?: number | null
  issueKey?: string
  repoId?: number | null
  projectKey?: string
  title: string
  description?: string
  kind?: FollowUpKind
  priority?: 'low' | 'medium' | 'high'
  files?: string[]
  source?: string
}): number | null {
  // kind deliberately NOT hashed: the same suggestion re-labeled todo vs
  // tech_debt between rounds must still collide.
  const hash = dedupeHash('followup', f.repoId ?? null, f.title)
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO followups
         (task_id, issue_key, repo_id, project_key, title, description, kind, priority, files_json, source, dedupe_hash)
       VALUES (@task_id, @issue_key, @repo_id, @project_key, @title, @description, @kind, @priority, @files_json, @source, @dedupe_hash)`
    )
    .run({
      task_id: f.taskId ?? null,
      issue_key: f.issueKey ?? '',
      repo_id: f.repoId ?? null,
      project_key: f.projectKey ?? '',
      title: f.title,
      description: f.description ?? '',
      kind: f.kind ?? 'todo',
      priority: f.priority ?? 'medium',
      files_json: JSON.stringify(f.files ?? []),
      source: f.source ?? 'signal',
      dedupe_hash: hash
    })
  return info.changes > 0 ? Number(info.lastInsertRowid) : null
}

export function listFollowUps(status?: FollowUpStatus): FollowUp[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM followups WHERE status = ? ORDER BY created_at DESC').all(status)
      : getDb().prepare('SELECT * FROM followups ORDER BY created_at DESC').all()
  ) as FollowUpRow[]
  return rows.map(rowToFollowUp)
}

/**
 * The slice pushed to the renderer: open candidates plus a 7-day window of
 * resolved rows (the Insights view shows "recently created" for a week).
 * The full history stays queryable via listFollowUps for the dedupe engine.
 */
export function listFollowUpsForState(limit = 300): FollowUp[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM followups
       WHERE status = 'candidate' OR updated_at >= datetime('now', '-7 days')
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as FollowUpRow[]
  return rows.map(rowToFollowUp)
}

export function getFollowUp(id: number): FollowUp | null {
  const row = getDb().prepare('SELECT * FROM followups WHERE id = ?').get(id) as FollowUpRow | undefined
  return row ? rowToFollowUp(row) : null
}

export function updateFollowUp(
  id: number,
  patch: { title?: string; description?: string; projectKey?: string; priority?: 'low' | 'medium' | 'high' }
): void {
  const cur = getFollowUp(id)
  if (!cur) return
  getDb()
    .prepare(
      `UPDATE followups SET title = ?, description = ?, project_key = ?, priority = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(
      patch.title ?? cur.title,
      patch.description ?? cur.description,
      patch.projectKey ?? cur.projectKey,
      patch.priority ?? cur.priority,
      id
    )
}

/** Remove a follow-up entirely (semantic-duplicate drop). */
export function deleteFollowUp(id: number): void {
  getDb().prepare('DELETE FROM followups WHERE id = ?').run(id)
}

export function setFollowUpStatus(id: number, status: FollowUpStatus, createdIssueKey = ''): void {
  getDb()
    .prepare(
      `UPDATE followups SET status = ?, created_issue_key = ?, updated_at = datetime('now') WHERE id = ?`
    )
    .run(status, createdIssueKey, id)
}

// ---- knowledge ----

interface KnowledgeRow {
  id: number
  scope: 'repo' | 'project' | 'global'
  repo_id: number | null
  project_key: string
  role: KnowledgeRole
  insight: string
  evidence: string
  confidence: 'low' | 'medium' | 'high'
  status: KnowledgeStatus
  source: string
  hit_count: number
  last_applied_at: string | null
  created_at: string
  updated_at: string
}

function rowToKnowledge(r: KnowledgeRow): KnowledgeItem {
  return {
    id: r.id,
    scope: r.scope,
    repoId: r.repo_id,
    projectKey: r.project_key,
    role: r.role,
    insight: r.insight,
    evidence: r.evidence,
    confidence: r.confidence,
    status: r.status,
    source: r.source,
    hitCount: r.hit_count,
    lastAppliedAt: r.last_applied_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

export function insertKnowledge(k: {
  scope?: 'repo' | 'project' | 'global'
  repoId?: number | null
  projectKey?: string
  role?: KnowledgeRole
  insight: string
  evidence?: string
  confidence?: 'low' | 'medium' | 'high'
  status?: KnowledgeStatus
  source?: string
}): number | null {
  const hash = dedupeHash('knowledge', k.repoId ?? null, k.role ?? 'coding', k.insight)
  const info = getDb()
    .prepare(
      `INSERT OR IGNORE INTO knowledge
         (scope, repo_id, project_key, role, insight, evidence, confidence, status, source, dedupe_hash)
       VALUES (@scope, @repo_id, @project_key, @role, @insight, @evidence, @confidence, @status, @source, @dedupe_hash)`
    )
    .run({
      scope: k.scope ?? 'repo',
      repo_id: k.repoId ?? null,
      project_key: k.projectKey ?? '',
      role: k.role ?? 'coding',
      insight: k.insight,
      evidence: k.evidence ?? '',
      confidence: k.confidence ?? 'medium',
      status: k.status ?? 'candidate',
      source: k.source ?? 'signal',
      dedupe_hash: hash
    })
  return info.changes > 0 ? Number(info.lastInsertRowid) : null
}

export function listKnowledge(status?: KnowledgeStatus): KnowledgeItem[] {
  const rows = (
    status
      ? getDb().prepare('SELECT * FROM knowledge WHERE status = ? ORDER BY created_at DESC').all(status)
      : getDb().prepare('SELECT * FROM knowledge ORDER BY created_at DESC').all()
  ) as KnowledgeRow[]
  return rows.map(rowToKnowledge)
}

/** The slice pushed to the renderer: only statuses the Insights view renders. */
export function listKnowledgeForState(limit = 300): KnowledgeItem[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM knowledge WHERE status IN ('candidate', 'active')
       ORDER BY created_at DESC LIMIT ?`
    )
    .all(limit) as KnowledgeRow[]
  return rows.map(rowToKnowledge)
}

export function setKnowledgeStatus(id: number, status: KnowledgeStatus): void {
  getDb()
    .prepare(`UPDATE knowledge SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, id)
}

/**
 * The knowledge set injected into a new session's AGENTS.md: active items for
 * this repo (or global), matching the session's role, best-first, capped so the
 * injected block stays signal rather than noise.
 *
 * Review sessions get coding-role items TOO: learned coding conventions are
 * exactly what a reviewer should be checking for.
 */
export function selectKnowledgeForInjection(
  repoId: number,
  role: KnowledgeRole,
  limit = 15
): KnowledgeItem[] {
  const roles = role === 'review' ? ['review', 'coding'] : [role]
  const rows = getDb()
    .prepare(
      `SELECT * FROM knowledge
       WHERE status = 'active' AND role IN (${roles.map(() => '?').join(',')})
         AND (scope = 'global' OR repo_id = ?)
       ORDER BY CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                updated_at DESC
       LIMIT ?`
    )
    .all(...roles, repoId, limit) as KnowledgeRow[]
  return rows.map(rowToKnowledge)
}

/** Record that these knowledge rows were injected into a session. */
export function markKnowledgeApplied(ids: number[]): void {
  if (ids.length === 0) return
  const stmt = getDb().prepare(
    `UPDATE knowledge SET hit_count = hit_count + 1, last_applied_at = datetime('now') WHERE id = ?`
  )
  for (const id of ids) stmt.run(id)
}

/** Learning-loop aggregates for the metrics scorecard. */
export function insightsTotals(): {
  followupsCandidate: number
  followupsCreated: number
  followupsDismissed: number
  knowledgeCandidate: number
  knowledgeActive: number
  knowledgeRetired: number
  knowledgeApplications: number
} {
  const db = getDb()
  const f = db
    .prepare(`SELECT status, COUNT(*) AS n FROM followups GROUP BY status`)
    .all() as { status: string; n: number }[]
  const k = db
    .prepare(`SELECT status, COUNT(*) AS n FROM knowledge GROUP BY status`)
    .all() as { status: string; n: number }[]
  const apps = db.prepare(`SELECT COALESCE(SUM(hit_count), 0) AS n FROM knowledge`).get() as { n: number }
  const by = (rows: { status: string; n: number }[], s: string) => rows.find((r) => r.status === s)?.n ?? 0
  return {
    followupsCandidate: by(f, 'candidate'),
    followupsCreated: by(f, 'created'),
    followupsDismissed: by(f, 'dismissed'),
    knowledgeCandidate: by(k, 'candidate'),
    knowledgeActive: by(k, 'active'),
    knowledgeRetired: by(k, 'retired'),
    knowledgeApplications: apps.n
  }
}
