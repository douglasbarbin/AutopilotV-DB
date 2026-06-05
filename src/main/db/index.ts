import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'path'
import { rmSync } from 'fs'
import { runMigrations } from './migrations'
import { log } from '../log'

let db: Database.Database | null = null

function dbPath(): string {
  return join(app.getPath('userData'), 'autopilotv.db')
}

export function getDb(): Database.Database {
  if (db) return db
  const path = dbPath()
  log.info('opening database', { path })
  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

export function closeDb(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** Close, delete every database file, and reopen a fresh migrated database. */
export function resetDatabase(): void {
  closeDb()
  const base = dbPath()
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(base + suffix, { force: true })
  }
  log.warn('database wiped', { path: base })
  getDb()
}

/**
 * Test-only: open (or replace) the singleton database with an arbitrary
 * already-migrated instance. Returns the migrated database for the caller to
 * use directly. Not part of the production API; only exported so unit tests
 * can inject an in-memory DB without booting Electron.
 */
export function __setDbForTesting(instance: Database.Database): void {
  closeDb()
  db = instance
}

/** Test-only: open an in-memory database, run migrations, set it as the
 *  singleton, and return it. */
export function __openInMemoryDbForTesting(): Database.Database {
  const instance = new Database(':memory:')
  instance.pragma('foreign_keys = ON')
  runMigrations(instance)
  __setDbForTesting(instance)
  return instance
}
