import type { AppState, BrainNote } from '@shared/types/domain'
import { Icon } from './Icon'

const CATEGORY_META: Record<BrainNote['category'], { color: string; label: string }> = {
  refresh: { color: 'var(--blue)', label: 'Refresh' },
  schedule: { color: 'var(--purple)', label: 'Schedule' },
  reconcile: { color: 'var(--aqua)', label: 'Reconcile' },
  autodrive: { color: 'var(--orange)', label: 'Auto-drive' },
  review: { color: 'var(--green)', label: 'Review' },
  dev: { color: 'var(--yellow)', label: 'Dev' },
  decision: { color: 'var(--comment)', label: 'Decision' }
}

export function BrainPanel({ state }: { state: AppState }) {
  const notes = state.brainNotes
  // Group by tick, newest first.
  const groups = new Map<number, BrainNote[]>()
  for (const n of notes) {
    if (!groups.has(n.tick)) groups.set(n.tick, [])
    groups.get(n.tick)!.push(n)
  }
  const orderedTicks = [...groups.keys()].sort((a, b) => b - a)

  return (
    <div className="brain-panel">
      <div className="brain-hero">
        <div className="brain-hero-icon">
          <Icon name="brain" size={26} />
        </div>
        <div>
          <h2>{state.brain.running ? 'The brain is on autopilot' : 'The brain is paused'}</h2>
          <p>
            Every {state.settings.pollIntervalSeconds}s it reviews what work is yours, decides what
            to do, and drives sessions to completion. Its reasoning streams below.
          </p>
        </div>
        <div className="brain-hero-stat">
          <span className="big">#{state.brain.tick}</span>
          <span className="sub">ticks</span>
        </div>
      </div>

      {notes.length === 0 && (
        <div className="empty">
          No reasoning yet. Hit <strong>Tick now</strong> to watch the brain work.
        </div>
      )}

      <div className="reason-feed">
        {orderedTicks.map((tick) => (
          <div className="reason-tick" key={tick}>
            <div className="reason-tick-head">
              <span className="reason-tick-label">Tick #{tick}</span>
              <span className="reason-tick-time">{timeOf(groups.get(tick)![0].ts)}</span>
            </div>
            <div className="reason-lines">
              {groups
                .get(tick)!
                .slice()
                .reverse()
                .map((n) => {
                  const meta = CATEGORY_META[n.category]
                  return (
                    <div className={`reason-line ${n.level}`} key={n.id}>
                      <span className="reason-cat" style={{ color: meta.color, borderColor: meta.color }}>
                        {meta.label}
                      </span>
                      <span className="reason-msg">{n.message}</span>
                    </div>
                  )
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function timeOf(ts: string): string {
  return ts.split(' ')[1] ?? ts
}
