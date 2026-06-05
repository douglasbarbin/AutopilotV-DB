/**
 * Re-export of the singleton database handle, so per-table store modules don't
 * need to know where the SQLite file lives. Importing from here (instead of
 * ../db directly) keeps the store layer swappable: a future test harness can
 * stub this module to inject an in-memory DB.
 */
export { getDb } from '../db'
