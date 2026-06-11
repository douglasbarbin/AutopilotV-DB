import { useEffect, useState } from 'react'
import type { AppState, BrainNote } from '@shared/types/domain'
import { Icon } from './Icon'
import { api } from '../api'

const CATEGORY_META: Record<BrainNote['category'], { color: string; label: string }> = {
  refresh: { color: 'var(--blue)', label: 'Refresh' },
  schedule: { color: 'var(--purple)', label: 'Schedule' },
  reconcile: { color: 'var(--aqua)', label: 'Reconcile' },
  autodrive: { color: 'var(--orange)', label: 'Auto-drive' },
  review: { color: 'var(--green)', label: 'Review' },
  dev: { color: 'var(--yellow)', label: 'Dev' },
  decision: { color: 'var(--comment)', label: 'Decision' }
}

/**
 * The brain page is the command center, not a passive log: run/pause and tick
 * controls live here, anything that needs the human is surfaced as an
 * actionable queue, and the reasoning feed is filterable by category and
 * severity.
 */
export function BrainPanel({
  state,
  onNavigate
}: {
  state: AppState
  onNavigate: (tab: 'sessions' | 'reviews' | 'work' | 'insights') => void
}) {
  const notes = state.brainNotes
  const [catFilter, setCatFilter] = useState<BrainNote['category'] | null>(null)
  const [warnOnly, setWarnOnly] = useState(false)

  const filtered = notes.filter(
    (n) =>
      (!catFilter || n.category === catFilter) &&
      (!warnOnly || n.level === 'warn' || n.level === 'error')
  )
  const groups = new Map<number, BrainNote[]>()
  for (const n of filtered) {
    if (!groups.has(n.tick)) groups.set(n.tick, [])
    groups.get(n.tick)!.push(n)
  }
  const orderedTicks = [...groups.keys()].sort((a, b) => b - a)

  // Attention queue: everything currently blocked on a human, with the action inline.
  const needsHuman = state.sessions.filter((s) => s.status === 'needs_human')
  const erroredTasks = state.tasks.filter((t) => t.phase === 'error')
  const mergeReady = state.tasks.filter((t) => t.phase === 'ready_to_merge')
  const awaitingReviews = state.prReviews.filter((p) => p.state === 'awaiting_user')
  const pendingInsights =
    state.followups.filter((f) => f.status === 'candidate').length +
    state.knowledge.filter((k) => k.status === 'candidate').length
  const attentionCount =
    needsHuman.length + erroredTasks.length + mergeReady.length + awaitingReviews.length

  return (
    <div className="brain-panel">
      <div className="brain-hero">
        <div className="brain-hero-icon">
          <Icon name="brain" size={26} />
        </div>
        <div className="brain-hero-text">
          <h2>{state.brain.running ? 'The brain is on autopilot' : 'The brain is paused'}</h2>
          <p>
            Every {state.settings.pollIntervalSeconds}s it reviews what work is yours, decides what
            to do, and drives sessions to completion.
          </p>
          <NextTick brain={state.brain} pollSeconds={state.settings.pollIntervalSeconds} />
        </div>
        <div className="brain-hero-actions">
          <button
            className={state.brain.running ? 'btn-soft' : 'btn-primary'}
            onClick={() => void api.setBrainRunning(!state.brain.running)}
          >
            <Icon name={state.brain.running ? 'pause' : 'play'} size={13} />{' '}
            {state.brain.running ? 'Pause' : 'Resume'}
          </button>
          <button className="btn-soft" disabled={state.brain.ticking} onClick={() => void api.tickNow()}>
            <Icon name="bolt" size={13} /> {state.brain.ticking ? 'Thinking…' : 'Tick now'}
          </button>
          <div className="brain-hero-stat">
            <span className="big">#{state.brain.tick}</span>
            <span className="sub">ticks</span>
          </div>
        </div>
      </div>

      {attentionCount > 0 && (
        <div className="attention-queue">
          <h3 className="section-sub">Needs you ({attentionCount})</h3>
          {needsHuman.map((s) => (
            <div className="attention-row" key={`s${s.id}`}>
              <span className="attention-dot" style={{ background: 'var(--red)' }} />
              <span className="attention-text">
                <strong>{s.title}</strong> — session needs a human{s.exitReason ? `: ${s.exitReason}` : ''}
              </span>
              <button className="btn-soft" onClick={() => onNavigate('sessions')}>
                Open session
              </button>
            </div>
          ))}
          {erroredTasks.map((t) => (
            <div className="attention-row" key={`t${t.id}`}>
              <span className="attention-dot" style={{ background: 'var(--orange)' }} />
              <span className="attention-text">
                <strong>{t.issueKey}</strong> — errored: {t.title}
              </span>
              <button className="btn-soft" onClick={() => void api.resetDev(t.id)}>
                Retry
              </button>
              <button className="btn-ghost" onClick={() => void api.skip({ kind: 'dev', id: t.id })}>
                Skip
              </button>
            </div>
          ))}
          {mergeReady.map((t) => (
            <div className="attention-row" key={`m${t.id}`}>
              <span className="attention-dot" style={{ background: 'var(--green)' }} />
              <span className="attention-text">
                <strong>{t.issueKey}</strong> — PR #{t.prNumber} passed every gate
                {t.reviewersRequested > 0 ? ` (${t.approvals}/${t.reviewersRequested} approved)` : ''}
              </span>
              <button className="btn-primary" onClick={() => void api.mergeDev(t.id)}>
                Merge
              </button>
            </div>
          ))}
          {awaitingReviews.length > 0 && (
            <div className="attention-row">
              <span className="attention-dot" style={{ background: 'var(--blue)' }} />
              <span className="attention-text">
                <strong>{awaitingReviews.length} review{awaitingReviews.length > 1 ? 's' : ''}</strong> prepared
                and awaiting your verdict
              </span>
              <button className="btn-soft" onClick={() => onNavigate('reviews')}>
                Open reviews
              </button>
            </div>
          )}
          {pendingInsights > 0 && (
            <div className="attention-row subtle">
              <span className="attention-dot" style={{ background: 'var(--purple)' }} />
              <span className="attention-text">
                {pendingInsights} backlog/learning candidate{pendingInsights > 1 ? 's' : ''} to triage
              </span>
              <button className="btn-ghost" onClick={() => onNavigate('insights')}>
                Open insights
              </button>
            </div>
          )}
        </div>
      )}

      <div className="reason-filterbar">
        <span className="sub">Reasoning</span>
        {Object.entries(CATEGORY_META).map(([cat, meta]) => (
          <button
            key={cat}
            className={`reason-filter ${catFilter === cat ? 'active' : ''}`}
            style={catFilter === cat ? { color: meta.color, borderColor: meta.color } : undefined}
            onClick={() => setCatFilter(catFilter === cat ? null : (cat as BrainNote['category']))}
          >
            {meta.label}
          </button>
        ))}
        <button
          className={`reason-filter ${warnOnly ? 'active warn' : ''}`}
          onClick={() => setWarnOnly((v) => !v)}
        >
          ⚠ problems only
        </button>
      </div>

      {filtered.length === 0 && (
        <div className="empty">
          {notes.length === 0 ? (
            <>
              No reasoning yet. Hit <strong>Tick now</strong> to watch the brain work.
            </>
          ) : (
            'Nothing matches the current filter.'
          )}
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
                      <span
                        className="reason-cat clickable"
                        style={{ color: meta.color, borderColor: meta.color }}
                        title={`Filter by ${meta.label}`}
                        onClick={() => setCatFilter(catFilter === n.category ? null : n.category)}
                      >
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

/** Live countdown to the next tick — makes the poll loop feel alive. */
function NextTick({ brain, pollSeconds }: { brain: AppState['brain']; pollSeconds: number }) {
  const [, force] = useState(0)
  useEffect(() => {
    const t = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])
  if (!brain.running) return <p className="muted">Paused — nothing runs until you resume.</p>
  if (brain.ticking) return <p className="muted">Thinking right now…</p>
  if (!brain.lastTickAt) return null
  const elapsed = (Date.now() - Date.parse(brain.lastTickAt)) / 1000
  const remaining = Math.max(0, Math.round(pollSeconds - elapsed))
  return (
    <p className="muted">
      Next tick in ~{remaining}s
      <span className="nexttick-bar">
        <span
          className="nexttick-fill"
          style={{ width: `${Math.min(100, (elapsed / pollSeconds) * 100)}%` }}
        />
      </span>
    </p>
  )
}

function timeOf(ts: string): string {
  return ts.split(' ')[1] ?? ts
}
