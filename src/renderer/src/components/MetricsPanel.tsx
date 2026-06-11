import { useEffect, useState } from 'react'
import type { DailyActivity, MetricsSnapshot } from '@shared/types/domain'
import { api } from '../api'

/**
 * GitHub-style shipped-work heatmap: 17 weeks × 7 days. Green intensity =
 * merges + reviews shipped that day; a day where verification failed gets an
 * orange ring — value and failures readable at a glance, no numbers required.
 */
function Heatmap({ daily }: { daily: DailyActivity[] }) {
  const byDate = new Map(daily.map((d) => [d.date, d]))
  const weeks = 17
  const today = new Date()
  // Start from the Sunday `weeks` back.
  const start = new Date(today)
  start.setDate(start.getDate() - (weeks * 7 - 1) - today.getDay())
  const cells: { date: string; d: DailyActivity | undefined; future: boolean }[] = []
  for (let i = 0; i < weeks * 7; i++) {
    const day = new Date(start)
    day.setDate(start.getDate() + i)
    const iso = day.toISOString().slice(0, 10)
    cells.push({ date: iso, d: byDate.get(iso), future: day > today })
  }
  const max = Math.max(1, ...daily.map((d) => d.merges + d.reviews))
  const level = (d?: DailyActivity) => {
    const v = d ? d.merges + d.reviews : 0
    if (v === 0) return 0
    return Math.min(4, Math.ceil((v / max) * 4))
  }
  return (
    <div className="heatmap" style={{ gridTemplateColumns: `repeat(${weeks}, 1fr)` }}>
      {Array.from({ length: weeks }, (_, w) => (
        <div className="heatmap-col" key={w}>
          {Array.from({ length: 7 }, (_, dow) => {
            const c = cells[w * 7 + dow]
            const v = c.d ? c.d.merges + c.d.reviews : 0
            return (
              <span
                key={dow}
                className={`heatmap-cell l${level(c.d)} ${c.d?.failures ? 'failed' : ''} ${c.future ? 'future' : ''}`}
                title={
                  c.future
                    ? ''
                    : `${c.date} — ${c.d?.merges ?? 0} merged · ${c.d?.reviews ?? 0} reviews${
                        c.d?.failures ? ` · ${c.d.failures} verification failure(s)` : ''
                      }${v === 0 && !c.d?.failures ? ' · quiet' : ''}`
                }
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

/** One horizontal bar split into colored proportional segments. */
function SegmentBar({
  segments,
  height = 10
}: {
  segments: { label: string; value: number; color: string }[]
  height?: number
}) {
  const total = segments.reduce((a, s) => a + s.value, 0)
  if (total === 0) return <div className="segbar empty-bar" style={{ height }} />
  return (
    <div className="segbar" style={{ height }}>
      {segments
        .filter((s) => s.value > 0)
        .map((s) => (
          <span
            key={s.label}
            className="segbar-seg"
            style={{ width: `${(s.value / total) * 100}%`, background: s.color }}
            title={`${s.label}: ${s.value}`}
          />
        ))}
    </div>
  )
}

/** Minutes → compact human string ("12m", "1.4h", "—"). */
function fmtMins(m: number | null): string {
  if (m == null) return '—'
  if (m < 90) return `${Math.round(m)}m`
  return `${(m / 60).toFixed(1)}h`
}

function fmtPct(x: number | null): string {
  return x == null ? '—' : `${Math.round(x * 100)}%`
}

function fmtNum(x: number | null): string {
  return x == null ? '—' : x.toFixed(1)
}

export function MetricsPanel() {
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = () => {
    void api.getMetrics().then((m) => {
      setMetrics(m)
      setLoading(false)
    })
  }

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 30_000)
    return () => clearInterval(t)
  }, [])

  if (loading || !metrics) {
    return <div className="empty">Crunching the numbers…</div>
  }

  const { dev, review, harnesses, insights } = metrics

  return (
    <div className="metrics-panel">
      <div className="metrics-head">
        <h3>Throughput &amp; quality</h3>
        <button className="btn-soft" onClick={refresh}>
          Refresh
        </button>
      </div>

      <h3 className="metrics-section">Shipped work — last 17 weeks</h3>
      <Heatmap daily={metrics.daily} />
      <div className="heatmap-legend work-sub">
        <span>less</span>
        {[0, 1, 2, 3, 4].map((l) => (
          <span key={l} className={`heatmap-cell l${l}`} />
        ))}
        <span>more</span>
        <span className="heatmap-cell l2 failed" />
        <span>= day with verification failures</span>
      </div>

      <div className="metric-cards">
        <Stat label="Tasks merged" value={`${dev.tasksMerged}`} sub={`${dev.tasksMerged7d} in 7d · ${dev.tasksMerged30d} in 30d`} />
        <Stat label="Avg time to ready" value={fmtMins(dev.avgTimeToReadyMinutes)} />
        <Stat label="Avg time to merge" value={fmtMins(dev.avgTimeToMergeMinutes)} />
        <Stat label="Avg rework / merge" value={fmtNum(dev.avgReworkCycles)} sub="changes-requested + verify-fix rounds" />
      </div>

      <div className="metric-bars">
        <div className="metric-bar-row">
          <span className="metric-bar-label">Verification {fmtPct(dev.verificationPassRate)}</span>
          <SegmentBar
            segments={[
              {
                label: 'passed',
                value: Math.round((dev.verificationPassRate ?? 0) * 100),
                color: 'var(--green)'
              },
              {
                label: 'failed',
                value: dev.verificationPassRate == null ? 0 : Math.round((1 - dev.verificationPassRate) * 100),
                color: 'var(--red)'
              }
            ]}
          />
        </div>
        <div className="metric-bar-row">
          <span className="metric-bar-label">Review verdicts ({review.completed})</span>
          <SegmentBar
            segments={[
              { label: 'approve', value: review.recommendations.approve ?? 0, color: 'var(--green)' },
              {
                label: 'request changes',
                value: review.recommendations.request_changes ?? 0,
                color: 'var(--orange)'
              },
              { label: 'comment', value: review.recommendations.comment ?? 0, color: 'var(--blue)' }
            ]}
          />
        </div>
        <div className="metric-bar-row">
          <span className="metric-bar-label">Human agreement {fmtPct(review.humanApproveRate)}</span>
          <SegmentBar
            segments={[
              {
                label: 'approved as recommended',
                value: Math.round((review.humanApproveRate ?? 0) * 100),
                color: 'var(--aqua)'
              },
              {
                label: 'overridden',
                value: review.humanApproveRate == null ? 0 : Math.round((1 - review.humanApproveRate) * 100),
                color: 'var(--comment)'
              }
            ]}
          />
        </div>
      </div>

      <h3 className="metrics-section">Learning loop</h3>
      <div className="metric-cards">
        <Stat
          label="Follow-ups harvested"
          value={`${insights.followupsCandidate + insights.followupsCreated + insights.followupsDismissed}`}
          sub={`${insights.followupsCandidate} pending · ${insights.followupsCreated} became stories · ${insights.followupsDismissed} dismissed`}
        />
        <Stat
          label="Knowledge base"
          value={`${insights.knowledgeActive} active`}
          sub={`${insights.knowledgeCandidate} candidate · ${insights.knowledgeRetired} retired`}
        />
        <Stat
          label="Knowledge applications"
          value={`${insights.knowledgeApplications}`}
          sub="times learned conventions were injected into a session"
        />
      </div>

      <h3 className="metrics-section">Per-harness scorecards</h3>
      {harnesses.length === 0 && <div className="empty">No sessions recorded yet.</div>}
      <div className="scorecards">
        {harnesses.map((h) => (
          <div className="scorecard" key={h.harnessId}>
            <div className="scorecard-head">
              <strong>{h.displayName}</strong>
              <span className="work-sub">{h.sessionsTotal} sessions</span>
            </div>
            <div className="scorecard-grid">
              <Mini label="dev / review" value={`${h.sessionsDev} / ${h.sessionsReview}`} />
              <Mini label="avg duration" value={fmtMins(h.avgSessionMinutes)} />
              <Mini label="median" value={fmtMins(h.medianSessionMinutes)} />
              <Mini label="needs-human" value={`${h.endedNeedsHuman}`} />
              <Mini label="killed" value={`${h.endedKilled}`} />
              <Mini label="reviews" value={`${h.reviewsCaptured}`} />
            </div>
            {Object.keys(h.reviewRecommendations).length > 0 && (
              <div className="scorecard-recs">
                {Object.entries(h.reviewRecommendations).map(([k, v]) => (
                  <span key={k} className="rec-chip">
                    {v} {k.replace('_', ' ')}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="metrics-foot work-sub">
        Generated {new Date(metrics.generatedAt).toLocaleTimeString()} · time / rework / outcome only (no token data)
      </div>
    </div>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
      {sub && <div className="metric-sub work-sub">{sub}</div>}
    </div>
  )
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div className="scorecard-mini">
      <span className="scorecard-mini-value">{value}</span>
      <span className="scorecard-mini-label">{label}</span>
    </div>
  )
}
