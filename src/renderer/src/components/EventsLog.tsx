import type { AppState } from '@shared/types/domain'

const LEVEL_COLOR: Record<string, string> = {
  debug: 'var(--comment)',
  info: 'var(--blue)',
  warn: 'var(--yellow)',
  error: 'var(--red)'
}

export function EventsLog({ state }: { state: AppState }) {
  return (
    <div className="events-log">
      {state.events.map((e) => (
        <div className="event-row" key={e.id}>
          <span className="event-ts">{e.ts.split(' ')[1] ?? e.ts}</span>
          <span className="event-level" style={{ color: LEVEL_COLOR[e.level] }}>
            {e.level}
          </span>
          <span className="event-kind">{e.kind}</span>
          <span className="event-payload">{summarize(e.payload)}</span>
        </div>
      ))}
    </div>
  )
}

function summarize(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
  if (entries.length === 0) return ''
  return entries.map(([k, v]) => `${k}=${truncate(String(v))}`).join(' ')
}

function truncate(s: string): string {
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}
