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
