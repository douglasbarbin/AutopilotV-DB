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
