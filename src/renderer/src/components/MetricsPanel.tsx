import { useEffect, useState } from 'react'
import type { MetricsSnapshot } from '@shared/types/domain'
import { api } from '../api'

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

  const { dev, review, harnesses } = metrics

  return (
    <div className="metrics-panel">
      <div className="metrics-head">
        <h3>Throughput &amp; quality</h3>
        <button className="btn-soft" onClick={refresh}>
          Refresh
        </button>
      </div>

      <div className="metric-cards">
        <Stat label="Tasks merged" value={`${dev.tasksMerged}`} sub={`${dev.tasksMerged7d} in 7d · ${dev.tasksMerged30d} in 30d`} />
        <Stat label="Avg time to ready" value={fmtMins(dev.avgTimeToReadyMinutes)} />
        <Stat label="Avg time to merge" value={fmtMins(dev.avgTimeToMergeMinutes)} />
        <Stat label="Avg rework / merge" value={fmtNum(dev.avgReworkCycles)} sub="changes-requested + verify-fix rounds" />
        <Stat label="Verification pass rate" value={fmtPct(dev.verificationPassRate)} />
        <Stat label="Resets" value={`${dev.resets}`} />
      </div>

      <h3 className="metrics-section">Reviews</h3>
      <div className="metric-cards">
        <Stat label="Reviews completed" value={`${review.completed}`} />
        <Stat label="Avg review time" value={fmtMins(review.avgReviewMinutes)} />
        <Stat label="Human approve rate" value={fmtPct(review.humanApproveRate)} />
        <Stat
          label="Recommendation mix"
          value={
            Object.keys(review.recommendations).length
              ? Object.entries(review.recommendations)
                  .map(([k, v]) => `${v} ${k.replace('_', ' ')}`)
                  .join(' · ')
              : '—'
          }
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
