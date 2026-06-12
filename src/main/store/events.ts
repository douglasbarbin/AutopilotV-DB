/**
 * Append-only event log. The renderer subscribes to this via the snapshot
 * push; the brain also writes `brain.note` rows here so the Brain feed
 * (which is a filtered view of events) is one source of truth.
 */
import { getDb } from './_db'
import type { AppEvent, BrainNote } from '@shared/types/domain'

interface EventRow {
  id: number
  ts: string
  level: AppEvent['level']
  session_id: number | null
  kind: string
  payload_json: string
}

function rowToEvent(r: EventRow): AppEvent {
  return {
    id: r.id,
    ts: r.ts,
    level: r.level,
    sessionId: r.session_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json)
  }
}

export function recordEvent(
  kind: string,
  payload: Record<string, unknown> = {},
  opts: { level?: AppEvent['level']; sessionId?: number | null } = {}
): void {
  getDb()
    .prepare('INSERT INTO events (level, session_id, kind, payload_json) VALUES (?, ?, ?, ?)')
    .run(opts.level ?? 'info', opts.sessionId ?? null, kind, JSON.stringify(payload))
}

/** Retention sweep: drop events (incl. brain notes) older than `days`.
 *  The log is append-only and grows by hundreds of rows a day; the UI only
 *  ever shows the most recent 200. Returns the number of rows deleted. */
export function pruneEvents(days = 30): number {
  const info = getDb()
    .prepare("DELETE FROM events WHERE ts < datetime('now', ?)")
    .run(`-${days} days`)
  return info.changes
}

export function listEvents(limit = 200): AppEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
    .all(limit) as EventRow[]
  return rows.map(rowToEvent)
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
    .all(limit) as EventRow[]
  return rows.map((r) => {
    const p = JSON.parse(r.payload_json) as Record<string, unknown>
    const tick = (p.tick as number | undefined) ?? 0
    const category = (p.category as BrainNote['category'] | undefined) ?? 'decision'
    const message = (p.message as string | undefined) ?? r.kind
    const { tick: _t, category: _c, message: _m, ...detail } = p
    return {
      id: r.id,
      ts: r.ts,
      tick,
      level: r.level,
      category,
      message,
      detail: detail as Record<string, unknown>
    }
  })
}
