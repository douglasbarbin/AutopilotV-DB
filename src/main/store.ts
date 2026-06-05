import { existsSync } from 'fs'
import { join } from 'path'
import { getDb } from './db'
import { DEFAULT_SETTINGS, SEED_HARNESSES } from './config/defaults'
import { log } from './log'
import type {
  AppEvent,
  BrainNote,
  ClaimState,
  HarnessConfig,
  IntegrationHealth,
  TrackerProject,
  TrackerTask,
  PrReview,
  PrReviewState,
  Repo,
  ReviewAction,
  ReviewSummary,
  Session,
  SessionStatus,
  Settings,
  TaskStatus,
  Worktree,
  WorkKind
} from '@shared/types/domain'

const LEASE_MINUTES = 15

// ---------- settings & kv ----------

function kvGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function kvSet(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value)
}

export function getSettings(): Settings {
  const raw = kvGet('settings')
  if (!raw) return DEFAULT_SETTINGS
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  kvSet('settings', JSON.stringify(next))
  return next
}

// ---------- harnesses ----------

export function seedIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM harnesses').get() as { c: number }).c
  if (count > 0) return
  log.info('seeding default harnesses')
  for (const h of SEED_HARNESSES) upsertHarness(h)
}

/**
 * One-time application of the model defaults (brain → gemma, local coding → qwen)
 * to an already-seeded install. Idempotent via a kv flag, and only patches
 * persisted settings if the user already has a saved settings row.
 */
export function applyModelDefaults(): void {
  if (kvGet('model_defaults') === 'v7') return

  // Ensure Claude runs in auto permission mode.
  const claude = getHarness('claude')
  if (claude) {
    claude.launch = { ...claude.launch, args: ['--permission-mode', 'auto'] }
    upsertHarness(claude)
  }

  const coder = getHarness('pi')
  if (coder) {
    coder.displayName = 'Pi · Qwen3 Coder'
    coder.launch = { ...coder.launch, command: 'pi', args: [] } // managed flags injected at spawn
    coder.localModel = {
      ...(coder.localModel ?? { name: '', endpoint: '' }),
      name: 'qwen/qwen3-coder-30b',
      endpoint: 'http://127.0.0.1:1234'
    }
    upsertHarness(coder)
  }

  // Only touch persisted settings if a saved row exists; otherwise DEFAULT_SETTINGS
  // (now local/gemma) already applies live.
  if (kvGet('settings')) {
    updateSettings({
      llmProvider: 'local',
      llmModel: 'gemma-4-e4b-it-mlx',
      localLlmEndpoint: 'http://127.0.0.1:1234'
    })
  }

  kvSet('model_defaults', 'v7')
  log.info('applied model defaults: brain=gemma-4-e4b-it-mlx, coding=qwen/qwen3-coder-30b')
}

export function listHarnesses(): HarnessConfig[] {
  const rows = getDb().prepare('SELECT * FROM harnesses ORDER BY display_name').all() as Array<{
    config_json: string
  }>
  return rows.map((r) => JSON.parse(r.config_json) as HarnessConfig)
}

export function getHarness(id: string): HarnessConfig | null {
  const row = getDb().prepare('SELECT config_json FROM harnesses WHERE id = ?').get(id) as
    | { config_json: string }
    | undefined
  return row ? (JSON.parse(row.config_json) as HarnessConfig) : null
}

export function getReviewHarness(): HarnessConfig | null {
  return listHarnesses().find((h) => h.isReviewDefault && h.enabled) ?? null
}

export function getBrainHarness(): HarnessConfig | null {
  return listHarnesses().find((h) => h.isBrainDefault && h.enabled) ?? null
}

export function getCodingHarness(): HarnessConfig | null {
  return (
    listHarnesses().find((h) => h.isCodingDefault && h.enabled) ??
    listHarnesses().find((h) => h.enabled) ??
    null
  )
}

/** Clear a role-default flag on every harness (config_json is the source of truth). */
function clearRoleDefault(flag: 'isReviewDefault' | 'isBrainDefault' | 'isCodingDefault'): void {
  getDb()
    .prepare(`UPDATE harnesses SET config_json = json_set(config_json, '$.${flag}', json('false'))`)
    .run()
  if (flag === 'isReviewDefault') getDb().prepare('UPDATE harnesses SET is_review_default = 0').run()
}

export function upsertHarness(cfg: HarnessConfig): void {
  // Enforce a single default per role across all harnesses.
  if (cfg.isReviewDefault) clearRoleDefault('isReviewDefault')
  if (cfg.isBrainDefault) clearRoleDefault('isBrainDefault')
  if (cfg.isCodingDefault) clearRoleDefault('isCodingDefault')
  getDb()
    .prepare(
      `INSERT INTO harnesses (id, display_name, config_json, enabled, is_review_default)
       VALUES (@id, @display_name, @config_json, @enabled, @is_review_default)
       ON CONFLICT(id) DO UPDATE SET
         display_name = @display_name, config_json = @config_json,
         enabled = @enabled, is_review_default = @is_review_default`
    )
    .run({
      id: cfg.id,
      display_name: cfg.displayName,
      config_json: JSON.stringify(cfg),
      enabled: cfg.enabled ? 1 : 0,
      is_review_default: cfg.isReviewDefault ? 1 : 0
    })
}

export function deleteHarness(id: string): void {
  getDb().prepare('DELETE FROM harnesses WHERE id = ?').run(id)
}

/** Repair a DB that ended up with multiple review defaults — keep exactly one. */
export function normalizeReviewDefault(): void {
  const defaults = listHarnesses().filter((h) => h.isReviewDefault)
  if (defaults.length > 1) {
    // upsertHarness clears the flag on every other harness (column + json).
    upsertHarness({ ...defaults[0], isReviewDefault: true })
    log.warn('normalized review default', { kept: defaults[0].id, cleared: defaults.length - 1 })
  }
}

// ---------- repos ----------

export function listRepos(): Repo[] {
  const rows = getDb().prepare('SELECT * FROM repos ORDER BY name').all() as any[]
  return rows.map(rowToRepo)
}

export function getRepo(id: number): Repo | null {
  const row = getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) as any
  return row ? rowToRepo(row) : null
}

export function upsertRepo(r: {
  name: string
  remote: string
  defaultBranch?: string
  path?: string | null
  /** Forge that owns this repo. Defaults to the active forge; pass explicitly
   *  when the caller knows better (e.g. migrating between forges). */
  forge?: string
}): Repo {
  const forge = r.forge ?? getSettings().forge
  getDb()
    .prepare(
      `INSERT INTO repos (name, remote, default_branch, path, clone_state, forge)
       VALUES (@name, @remote, @default_branch, @path, @clone_state, @forge)
       ON CONFLICT(name) DO UPDATE SET remote = @remote`
    )
    .run({
      name: r.name,
      remote: r.remote,
      default_branch: r.defaultBranch ?? 'main',
      path: r.path ?? null,
      clone_state: r.path ? 'present' : 'missing',
      forge
    })
  return getRepoByName(r.name)!
}

export function getRepoByName(name: string): Repo | null {
  const row = getDb().prepare('SELECT * FROM repos WHERE name = ?').get(name) as any
  return row ? rowToRepo(row) : null
}

export function setRepoCloneState(id: number, state: Repo['cloneState'], path?: string): void {
  getDb()
    .prepare('UPDATE repos SET clone_state = ?, path = COALESCE(?, path) WHERE id = ?')
    .run(state, path ?? null, id)
}

function rowToRepo(r: any): Repo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    remote: r.remote,
    defaultBranch: r.default_branch,
    cloneState: r.clone_state,
    forge: r.forge ?? 'github'
  }
}

// ---------- tasks (dev line) ----------

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
  const id = prev?.id ?? (db.prepare('SELECT id FROM tasks WHERE issue_key = ?').get(t.issueKey) as { id: number }).id
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
    .all() as any[]
  return rows.map(rowToTask)
}

export function getTask(id: number): TrackerTask | null {
  const row = getDb().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any
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

export function setTaskPhase(id: number, phase: TrackerTask['phase']): void {
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

/** Reset a dev task back to unclaimed so it can be retried from scratch. */
export function resetTask(id: number): void {
  getDb()
    .prepare(
      `UPDATE tasks SET phase = 'unclaimed', claim_state = 'unclaimed', lease_owner = NULL,
       lease_expires_at = NULL, session_id = NULL, worktree_id = NULL, repo_id = NULL,
       pr_number = NULL, pr_url = '', done_tracker_status = '', updated_at = datetime('now') WHERE id = ?`
    )
    .run(id)
}

function rowToTask(r: any): TrackerTask {
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
    claimState: r.claim_state,
    sessionId: r.session_id,
    updatedAt: r.updated_at
  }
}

// ---------- tracker projects ----------

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
  const rows = getDb().prepare('SELECT * FROM tracker_projects ORDER BY key').all() as any[]
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

/**
 * Resolve the repo a project's tasks should target, per the user's mapping.
 * Ensures the repo row exists and detects a local clone under the clone dir.
 * Returns null if the project has no mapping.
 */
export function resolveProjectRepo(projectKey: string): Repo | null {
  const row = getDb().prepare('SELECT repo_name FROM tracker_projects WHERE key = ?').get(projectKey) as
    | { repo_name: string }
    | undefined
  const name = row?.repo_name
  if (!name) return null
  let repo = getRepoByName(name)
  if (!repo) {
    const forge = getSettings().forge
    repo = upsertRepo({
      name,
      remote: forge === 'azuredevops' ? '' : `https://github.com/${name}.git`,
      forge
    })
  }
  if (repo.cloneState !== 'present') {
    const candidate = join(getSettings().cloneParentDir, name.split('/').pop()!)
    if (existsSync(join(candidate, '.git'))) {
      setRepoCloneState(repo.id, 'present', candidate)
      repo = getRepoByName(name)!
    }
  }
  return repo
}

export function isProjectEnabled(key: string): boolean {
  const row = getDb().prepare('SELECT enabled FROM tracker_projects WHERE key = ?').get(key) as
    | { enabled: number }
    | undefined
  // Unknown projects default to enabled (they've just been discovered).
  return row ? !!row.enabled : true
}

// ---------- pr reviews ----------

export function upsertPrReview(p: {
  prNumber: number
  repoId: number
  title: string
  author: string
  branch: string
  url: string
}): { review: PrReview; reRequested: boolean } {
  // Detect a re-request BEFORE the write. This PR was surfaced by the
  // review-requested query, so GitHub currently has a PENDING review request from
  // us. If we'd already finished it with an approve or request-changes (both of
  // which clear that request on GitHub), then its reappearance can only mean the
  // author re-requested review — so it's fresh work and should resurface.
  // Comment-only reviews and skips never clear the request, so their reappearance
  // is just the same unchanged request; leaving those terminal states alone avoids
  // re-reviewing the same PR every tick.
  const prev = getPrReviewByNumber(p.repoId, p.prNumber)
  let reRequested = false
  if (prev?.state === 'submitted') {
    const last = getLatestReviewForPr(prev.id)
    reRequested = last?.action === 'approve' || last?.action === 'request_changes'
  }

  // The PR's forge is whichever forge owns its repo at write time. This is
  // what lets the renderer + the review orchestrator route calls to the
  // right adapter without consulting the (potentially stale) active setting.
  const repo = getRepo(p.repoId)
  const forge = repo?.forge ?? 'github'

  getDb()
    .prepare(
      `INSERT INTO pr_reviews (pr_number, repo_id, title, author, branch, url, forge)
       VALUES (@pr_number, @repo_id, @title, @author, @branch, @url, @forge)
       ON CONFLICT(repo_id, pr_number) DO UPDATE SET
         title = @title, author = @author, branch = @branch, url = @url, forge = @forge, updated_at = datetime('now')`
    )
    .run({
      pr_number: p.prNumber,
      repo_id: p.repoId,
      title: p.title,
      author: p.author,
      branch: p.branch,
      url: p.url,
      forge
    })
  if (reRequested && prev) resetPrReview(prev.id)
  return { review: getPrReviewByNumber(p.repoId, p.prNumber)!, reRequested }
}

export function getPrReviewByNumber(repoId: number, prNumber: number): PrReview | null {
  const row = getDb()
    .prepare('SELECT * FROM pr_reviews WHERE repo_id = ? AND pr_number = ?')
    .get(repoId, prNumber) as any
  return row ? rowToPrReview(row) : null
}

export function getPrReview(id: number): PrReview | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id) as any
  return row ? rowToPrReview(row) : null
}

export function listPrReviews(): PrReview[] {
  const rows = getDb()
    .prepare('SELECT * FROM pr_reviews ORDER BY discovered_at DESC')
    .all() as any[]
  return rows.map(rowToPrReview)
}

export function setPrReviewState(id: number, state: PrReviewState): void {
  getDb()
    .prepare("UPDATE pr_reviews SET state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(state, id)
}

/** Reset a PR review back to discovered/unclaimed so it can be retried. */
export function resetPrReview(id: number): void {
  getDb()
    .prepare(
      `UPDATE pr_reviews
       SET state = 'discovered', claim_state = 'unclaimed', lease_owner = NULL,
           lease_expires_at = NULL, session_id = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(id)
}

function rowToPrReview(r: any): PrReview {
  const repo = getRepo(r.repo_id)
  return {
    id: r.id,
    prNumber: r.pr_number,
    repoId: r.repo_id,
    repoName: repo?.name ?? '?',
    title: r.title,
    author: r.author,
    branch: r.branch,
    url: r.url,
    state: r.state,
    claimState: r.claim_state,
    sessionId: r.session_id,
    discoveredAt: r.discovered_at,
    updatedAt: r.updated_at,
    forge: r.forge ?? repo?.forge ?? 'github'
  }
}

// ---------- review summaries ----------

export function insertReview(r: {
  prReviewId: number
  recommendation: ReviewAction
  summary: string
  findings: unknown[]
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO reviews (pr_review_id, recommendation, summary, findings_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(r.prReviewId, r.recommendation, r.summary, JSON.stringify(r.findings))
  return Number(info.lastInsertRowid)
}

export function listReviews(): ReviewSummary[] {
  const rows = getDb().prepare('SELECT * FROM reviews ORDER BY created_at DESC').all() as any[]
  return rows.map(rowToReview)
}

export function getLatestReviewForPr(prReviewId: number): ReviewSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM reviews WHERE pr_review_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(prReviewId) as any
  return row ? rowToReview(row) : null
}

export function recordReviewAction(reviewId: number, action: ReviewAction): void {
  getDb()
    .prepare("UPDATE reviews SET action = ?, acted_at = datetime('now') WHERE id = ?")
    .run(action, reviewId)
}

function rowToReview(r: any): ReviewSummary {
  return {
    id: r.id,
    prReviewId: r.pr_review_id,
    recommendation: r.recommendation,
    summary: r.summary,
    findings: JSON.parse(r.findings_json),
    createdAt: r.created_at,
    action: r.action,
    actedAt: r.acted_at
  }
}

// ---------- sessions ----------

export function createSession(s: {
  kind: WorkKind
  workRef: string
  harnessId: string
  worktreeId: number | null
  title: string
  autoDrive?: boolean
}): number {
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
  getDb().prepare('UPDATE sessions SET auto_inject_count = auto_inject_count + 1 WHERE id = ?').run(id)
  return (getDb().prepare('SELECT auto_inject_count AS c FROM sessions WHERE id = ?').get(id) as {
    c: number
  }).c
}

export function getSession(id: number): Session | null {
  const row = getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any
  return row ? rowToSession(row) : null
}

export function listSessions(): Session[] {
  const rows = getDb().prepare('SELECT * FROM sessions ORDER BY started_at DESC').all() as any[]
  return rows.map(rowToSession)
}

export function listActiveSessions(): Session[] {
  const rows = getDb()
    .prepare("SELECT * FROM sessions WHERE status IN ('starting','running','stalled','needs_human')")
    .all() as any[]
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

function rowToSession(r: any): Session {
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

// ---------- worktrees ----------

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
  const row = getDb().prepare('SELECT * FROM worktrees WHERE id = ?').get(id) as any
  return row ? rowToWorktree(row) : null
}

export function listWorktrees(): Worktree[] {
  const rows = getDb().prepare('SELECT * FROM worktrees ORDER BY created_at DESC').all() as any[]
  return rows.map(rowToWorktree)
}

export function listLiveWorktrees(): Worktree[] {
  const rows = getDb().prepare('SELECT * FROM worktrees WHERE pruned_at IS NULL').all() as any[]
  return rows.map(rowToWorktree)
}

export function markWorktreePruned(id: number): void {
  getDb().prepare("UPDATE worktrees SET pruned_at = datetime('now') WHERE id = ?").run(id)
}

function rowToWorktree(r: any): Worktree {
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

// ---------- claim / lease (atomic) ----------

/** Atomically claim a work item. Returns true if this caller won the claim. */
export function claimWork(
  kind: WorkKind,
  id: number,
  owner: string
): boolean {
  const table = kind === 'review' ? 'pr_reviews' : 'tasks'
  const info = getDb()
    .prepare(
      `UPDATE ${table}
       SET claim_state = 'claimed', lease_owner = ?, lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes'), updated_at = datetime('now')
       WHERE id = ? AND claim_state = 'unclaimed'`
    )
    .run(owner, id)
  return info.changes === 1
}

export function setClaimState(kind: WorkKind, id: number, state: ClaimState): void {
  const table = kind === 'review' ? 'pr_reviews' : 'tasks'
  getDb()
    .prepare(`UPDATE ${table} SET claim_state = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(state, id)
}

export function attachSessionToWork(kind: WorkKind, id: number, sessionId: number): void {
  const table = kind === 'review' ? 'pr_reviews' : 'tasks'
  getDb()
    .prepare(`UPDATE ${table} SET session_id = ?, claim_state = 'in_progress' WHERE id = ?`)
    .run(sessionId, id)
}

export function renewLease(kind: WorkKind, id: number, owner: string): void {
  const table = kind === 'review' ? 'pr_reviews' : 'tasks'
  getDb()
    .prepare(
      `UPDATE ${table} SET lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes') WHERE id = ? AND lease_owner = ?`
    )
    .run(id, owner)
}

export function releaseLease(kind: WorkKind, id: number): void {
  const table = kind === 'review' ? 'pr_reviews' : 'tasks'
  getDb()
    .prepare(
      `UPDATE ${table} SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`
    )
    .run(id)
}

/** Return expired-lease work items to unclaimed. Returns count reset. */
export function reclaimExpiredLeases(): number {
  let total = 0
  for (const table of ['tasks', 'pr_reviews']) {
    const info = getDb()
      .prepare(
        `UPDATE ${table}
         SET claim_state = 'unclaimed', lease_owner = NULL, lease_expires_at = NULL, session_id = NULL
         WHERE claim_state IN ('claimed','in_progress')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < datetime('now')`
      )
      .run()
    total += info.changes
  }
  return total
}

// ---------- events / audit ----------

export function recordEvent(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { level?: AppEvent['level']; sessionId?: number | null } = {}
): void {
  getDb()
    .prepare('INSERT INTO events (level, session_id, kind, payload_json) VALUES (?, ?, ?, ?)')
    .run(opts.level ?? 'info', opts.sessionId ?? null, kind, JSON.stringify(payload))
}

export function listEvents(limit = 200): AppEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as any[]
  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    level: r.level,
    sessionId: r.session_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json)
  }))
}

/** Record a human-readable line of brain reasoning. */
export function recordBrainNote(note: {
  tick: number
  category: BrainNote['category']
  message: string
  detail?: Record<string, unknown>
  level?: BrainNote['level']
}): void {
  getDb()
    .prepare('INSERT INTO events (level, kind, payload_json) VALUES (?, ?, ?)')
    .run(
      note.level ?? 'info',
      'brain.note',
      JSON.stringify({ tick: note.tick, category: note.category, message: note.message, ...(note.detail ?? {}) })
    )
}

export function listBrainNotes(limit = 200): BrainNote[] {
  const rows = getDb()
    .prepare("SELECT * FROM events WHERE kind = 'brain.note' ORDER BY id DESC LIMIT ?")
    .all(limit) as any[]
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json)
    const { tick, category, message, ...detail } = p
    return {
      id: r.id,
      ts: r.ts,
      tick: tick ?? 0,
      level: r.level,
      category: category ?? 'decision',
      message: message ?? r.kind,
      detail
    }
  })
}

// ---------- integration health (kept in kv) ----------

export function setIntegrationHealth(h: IntegrationHealth): void {
  const all = getIntegrationHealth()
  const next = all.filter((x) => x.name !== h.name).concat(h)
  kvSet('integration_health', JSON.stringify(next))
}

export function getIntegrationHealth(): IntegrationHealth[] {
  const raw = kvGet('integration_health')
  if (!raw) return []
  try {
    return JSON.parse(raw) as IntegrationHealth[]
  } catch {
    return []
  }
}
