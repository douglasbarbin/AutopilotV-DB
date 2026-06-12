import type Database from 'better-sqlite3'

interface Migration {
  version: number
  up: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: `
    CREATE TABLE harnesses (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      config_json TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      is_review_default INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      path TEXT,
      remote TEXT NOT NULL,
      default_branch TEXT NOT NULL DEFAULT 'main',
      clone_state TEXT NOT NULL DEFAULT 'missing'
    );

    CREATE TABLE tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jira_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      assignee TEXT,
      priority INTEGER NOT NULL DEFAULT 3,
      claim_state TEXT NOT NULL DEFAULT 'unclaimed',
      lease_owner TEXT,
      lease_expires_at TEXT,
      session_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE pr_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_number INTEGER NOT NULL,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      branch TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL DEFAULT 'discovered',
      claim_state TEXT NOT NULL DEFAULT 'unclaimed',
      lease_owner TEXT,
      lease_expires_at TEXT,
      session_id INTEGER,
      discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(repo_id, pr_number)
    );

    CREATE TABLE reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pr_review_id INTEGER NOT NULL REFERENCES pr_reviews(id),
      recommendation TEXT NOT NULL,
      summary TEXT NOT NULL,
      findings_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      action TEXT,
      acted_at TEXT
    );

    CREATE TABLE sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      work_ref TEXT NOT NULL,
      harness_id TEXT NOT NULL,
      worktree_id INTEGER,
      pid INTEGER,
      status TEXT NOT NULL DEFAULT 'starting',
      auto_inject_count INTEGER NOT NULL DEFAULT 0,
      last_output_at TEXT,
      title TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      exited_at TEXT,
      exit_reason TEXT
    );

    CREATE TABLE worktrees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL,
      repo_id INTEGER NOT NULL REFERENCES repos(id),
      branch TEXT NOT NULL,
      kind TEXT NOT NULL,
      session_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      pruned_at TEXT
    );

    CREATE TABLE events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'info',
      session_id INTEGER,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX idx_events_ts ON events(ts);
    CREATE INDEX idx_sessions_status ON sessions(status);
    `
  },
  {
    version: 2,
    up: `
    ALTER TABLE tasks ADD COLUMN issue_type TEXT NOT NULL DEFAULT 'Story';
    ALTER TABLE tasks ADD COLUMN sprint TEXT NOT NULL DEFAULT '';
    CREATE INDEX idx_events_kind ON events(kind);
    `
  },
  {
    version: 3,
    up: `
    ALTER TABLE tasks ADD COLUMN project_key TEXT NOT NULL DEFAULT '';
    CREATE TABLE jira_projects (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      first_seen TEXT NOT NULL DEFAULT (datetime('now'))
    );
    UPDATE tasks SET project_key = substr(jira_key, 1, instr(jira_key, '-') - 1)
      WHERE instr(jira_key, '-') > 0;
    `
  },
  {
    version: 4,
    up: `
    ALTER TABLE sessions ADD COLUMN auto_drive INTEGER NOT NULL DEFAULT 1;
    `
  },
  {
    version: 5,
    up: `
    ALTER TABLE tasks ADD COLUMN phase TEXT NOT NULL DEFAULT 'unclaimed';
    ALTER TABLE tasks ADD COLUMN pr_number INTEGER;
    ALTER TABLE tasks ADD COLUMN pr_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE tasks ADD COLUMN repo_id INTEGER;
    ALTER TABLE tasks ADD COLUMN worktree_id INTEGER;
    `
  },
  {
    version: 6,
    up: `
    ALTER TABLE jira_projects ADD COLUMN repo_name TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 7,
    up: `
    ALTER TABLE tasks ADD COLUMN jira_status TEXT NOT NULL DEFAULT 'To Do';
    `
  },
  {
    // done_jira_status: the raw tracker status a task had when it was last marked
    // done. Lets a refresh tell a genuine reopen (QA bounced it back to To Do)
    // apart from the lag right after we finish — so a completed task can be
    // re-queued, but not instantly re-implemented the moment it merges.
    version: 8,
    up: `
    ALTER TABLE tasks ADD COLUMN done_jira_status TEXT NOT NULL DEFAULT '';
    `
  },
  {
    // De-Jira-fy the schema: AutopilotV supports multiple trackers (Jira, Vikunja,
    // GitHub Projects), so the work-item columns/table get tracker-agnostic names.
    // Pure renames — no data moves.
    version: 9,
    up: `
    ALTER TABLE tasks RENAME COLUMN jira_key TO issue_key;
    ALTER TABLE tasks RENAME COLUMN jira_status TO tracker_status;
    ALTER TABLE tasks RENAME COLUMN done_jira_status TO done_tracker_status;
    ALTER TABLE jira_projects RENAME TO tracker_projects;
    `
  },
  {
    // Code-forge pluggability: tag each repo with the forge that owns it, and
    // mirror the forge onto each discovered PR so a stale repo can't trick us
    // into calling the wrong adapter. Default to 'github' so installs that
    // pre-date the new forge field keep working unchanged.
    version: 10,
    up: `
    ALTER TABLE repos ADD COLUMN forge TEXT NOT NULL DEFAULT 'github';
    ALTER TABLE pr_reviews ADD COLUMN forge TEXT NOT NULL DEFAULT 'github';
    `
  },
  {
    // Single source of truth: config_json is now the only place role-default
    // flags live. The legacy is_review_default column was both a redundant
    // denormalization (drifted in practice) and a path to bugs where the
    // column and the json disagreed. Back-fill any pre-existing rows so their
    // json reflects the prior column value, then drop the column.
    version: 11,
    up: `
    -- For any harness where the column was true, make sure config_json agrees.
    UPDATE harnesses
       SET config_json = json_set(config_json, '$.isReviewDefault', json(CASE WHEN is_review_default = 1 THEN 'true' ELSE 'false' END))
     WHERE is_review_default != json_extract(config_json, '$.isReviewDefault');
    -- Drop the column.
    ALTER TABLE harnesses DROP COLUMN is_review_default;
    `
  },
  {
    // Independent verification (theme B): before a dev task is surfaced as
    // ready_to_merge, AutopilotV runs the repo's own test/build command in the
    // worktree and (advisory) checks the diff against the ticket.
    //   - repos.verify_command: operator-configured command; NULL = auto-detect/skip.
    //   - tasks.verified_sha: the commit we last verified, so a satisfied gate
    //     doesn't re-run the command every tick — only a new pushed commit does.
    //   - task_verifications: one row per (commit, dimension) verdict.
    version: 12,
    up: `
    ALTER TABLE repos ADD COLUMN verify_command TEXT;
    ALTER TABLE tasks ADD COLUMN verified_sha TEXT NOT NULL DEFAULT '';
    CREATE TABLE task_verifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      pr_number INTEGER,
      commit_sha TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      detail_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_task_verifications_task ON task_verifications(task_id);
    `
  },
  {
    // Address review feedback at most once per PR head commit. GitHub's
    // "changes requested" review state is sticky — it stays true until the
    // reviewer re-reviews or dismisses, even after every thread is resolved and
    // a fix is pushed. Without a marker the brain re-spawns an address-comments
    // session every tick on that sticky flag. addressed_sha records the head
    // commit we last addressed so we do it once, then wait for the state to change.
    version: 13,
    up: `
    ALTER TABLE tasks ADD COLUMN addressed_sha TEXT NOT NULL DEFAULT '';
    `
  },
  {
    // Re-address when an ADDITIONAL comment arrives, even on the same commit.
    // addressed_threads records the unresolved-thread count at the moment we
    // last addressed feedback; a higher current count means a new comment came
    // in, so we run another round rather than waiting on the stale head SHA.
    version: 14,
    up: `
    ALTER TABLE tasks ADD COLUMN addressed_threads INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    // Post-implementation analysis (PM loop): structured follow-up work items
    // and learned knowledge harvested from agent signal reports, PR
    // conversations, and verification history.
    //   - followups: candidate backlog items surfaced in the Backlog &
    //     Insights pane; "Create story" pushes one to the tracker (human-gated)
    //     and records the created issue key.
    //   - knowledge: durable insights injected into future sessions' AGENTS.md.
    //     status: candidate (awaiting human accept) → active (injected) →
    //     retired. hit_count/last_applied_at track injection usage.
    // dedupe_hash is unique per table so the same item harvested twice
    // (e.g. report + post-merge analysis) inserts once (INSERT OR IGNORE).
    version: 15,
    up: `
    CREATE TABLE followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER,
      issue_key TEXT NOT NULL DEFAULT '',
      repo_id INTEGER,
      project_key TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      files_json TEXT NOT NULL DEFAULT '[]',
      source TEXT NOT NULL DEFAULT 'signal',
      status TEXT NOT NULL DEFAULT 'candidate',
      created_issue_key TEXT NOT NULL DEFAULT '',
      dedupe_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_followups_status ON followups(status);

    CREATE TABLE knowledge (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope TEXT NOT NULL DEFAULT 'repo',
      repo_id INTEGER,
      project_key TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'coding',
      insight TEXT NOT NULL,
      evidence TEXT NOT NULL DEFAULT '',
      confidence TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'candidate',
      source TEXT NOT NULL DEFAULT 'signal',
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_applied_at TEXT,
      dedupe_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_knowledge_status ON knowledge(status);
    `
  },
  {
    // Runbooks + staged verification checkpoints.
    //   - repos.runbook: operator override of the repo's RUNBOOK.md (plain
    //     English narrative + fenced yaml lifecycle slots). Empty = use the
    //     RUNBOOK.md committed in the repo, else the legacy verify_command.
    //   - task_verifications.checkpoint: when the verdict was produced —
    //     'commit' (per-push test stage), 'draft' (full pipeline when the PR
    //     reaches draft), 'merge_gate' (full pipeline before ready_to_merge).
    version: 16,
    up: `
    ALTER TABLE repos ADD COLUMN runbook TEXT NOT NULL DEFAULT '';
    ALTER TABLE task_verifications ADD COLUMN checkpoint TEXT NOT NULL DEFAULT 'commit';
    `
  },
  {
    // Reviewer progress surfaced on task cards: approvals and assigned
    // reviewers, refreshed from the forge each babysit tick.
    version: 17,
    up: `
    ALTER TABLE tasks ADD COLUMN approvals INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN reviewers_requested INTEGER NOT NULL DEFAULT 0;
    `
  },
  {
    // Indexes for the columns every tick and every state push filter on.
    // These tables are append-heavy; without them each buildState/scheduleWork
    // pass is a full table scan that gets slower as history accumulates.
    version: 18,
    up: `
    CREATE INDEX idx_tasks_phase ON tasks(phase);
    CREATE INDEX idx_tasks_status ON tasks(status);
    CREATE INDEX idx_tasks_updated ON tasks(updated_at);
    CREATE INDEX idx_pr_reviews_state ON pr_reviews(state);
    CREATE INDEX idx_pr_reviews_updated ON pr_reviews(updated_at);
    CREATE INDEX idx_reviews_pr_review ON reviews(pr_review_id);
    CREATE INDEX idx_sessions_started ON sessions(started_at);
    CREATE INDEX idx_worktrees_pruned ON worktrees(pruned_at);
    CREATE INDEX idx_task_verifications_verdict ON task_verifications(task_id, checkpoint, commit_sha, kind);
    `
  }
]

export function runMigrations(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`
  )
  const current =
    (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null })
      .v ?? 0
  for (const m of MIGRATIONS) {
    if (m.version > current) {
      const tx = db.transaction(() => {
        db.exec(m.up)
        db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version)
      })
      tx()
    }
  }
}
