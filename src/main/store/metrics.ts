/**
 * Raw SQL aggregates for the cost/quality scorecards (theme D). These run
 * dedicated COUNT/SUM/join queries over the full history (NOT the 200-row
 * capped listEvents) and return primitive rows; assembly into the typed
 * MetricsSnapshot (medians, means, name lookup, date diffs) lives in
 * ../metrics/scorecard.ts. No token data — time / rework / outcome only.
 */
import { getDb } from './_db'

export interface HarnessSessionAgg {
  harnessId: string
  sessionsTotal: number
  sessionsDev: number
  sessionsReview: number
  endedNeedsHuman: number
  endedKilled: number
}

export function harnessSessionAggregates(): HarnessSessionAgg[] {
  return getDb()
    .prepare(
      `SELECT harness_id AS harnessId,
              COUNT(*) AS sessionsTotal,
              SUM(CASE WHEN kind = 'dev' THEN 1 ELSE 0 END) AS sessionsDev,
              SUM(CASE WHEN kind = 'review' THEN 1 ELSE 0 END) AS sessionsReview,
              SUM(CASE WHEN status = 'needs_human' THEN 1 ELSE 0 END) AS endedNeedsHuman,
              SUM(CASE WHEN status = 'killed' THEN 1 ELSE 0 END) AS endedKilled
       FROM sessions GROUP BY harness_id`
    )
    .all() as HarnessSessionAgg[]
}

/** Per-session durations (minutes) for terminal sessions with both timestamps. */
export function sessionDurations(): { harnessId: string; kind: string; minutes: number }[] {
  return getDb()
    .prepare(
      `SELECT harness_id AS harnessId, kind,
              (julianday(exited_at) - julianday(started_at)) * 1440.0 AS minutes
       FROM sessions
       WHERE exited_at IS NOT NULL AND started_at IS NOT NULL`
    )
    .all() as { harnessId: string; kind: string; minutes: number }[]
}

export function reviewRecommendationsByHarness(): { harnessId: string; recommendation: string; n: number }[] {
  return getDb()
    .prepare(
      `SELECT s.harness_id AS harnessId, r.recommendation AS recommendation, COUNT(*) AS n
       FROM reviews r
       JOIN pr_reviews pr ON pr.id = r.pr_review_id
       JOIN sessions s ON s.id = pr.session_id
       GROUP BY s.harness_id, r.recommendation`
    )
    .all() as { harnessId: string; recommendation: string; n: number }[]
}

export function reviewsCapturedByHarness(): { harnessId: string; n: number }[] {
  return getDb()
    .prepare(
      `SELECT s.harness_id AS harnessId, COUNT(*) AS n
       FROM reviews r
       JOIN pr_reviews pr ON pr.id = r.pr_review_id
       JOIN sessions s ON s.id = pr.session_id
       GROUP BY s.harness_id`
    )
    .all() as { harnessId: string; n: number }[]
}

// ──────────────────────────── dev throughput ────────────────────────────

export function devMergedCounts(): { total: number; d7: number; d30: number } {
  return getDb()
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN ts >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS d7,
              SUM(CASE WHEN ts >= datetime('now','-30 days') THEN 1 ELSE 0 END) AS d30
       FROM events WHERE kind = 'dev.merged'`
    )
    .get() as { total: number; d7: number; d30: number }
}

/** First dev session start per dev work_ref (`dev:<taskId>`). */
export function devTaskStartTimes(): { workRef: string; startedAt: string }[] {
  return getDb()
    .prepare(
      `SELECT work_ref AS workRef, MIN(started_at) AS startedAt
       FROM sessions WHERE kind = 'dev' GROUP BY work_ref`
    )
    .all() as { workRef: string; startedAt: string }[]
}

/** Lifecycle events that carry a taskId in their payload, for time/rework calc. */
export function devLifecycleEvents(): { kind: string; ts: string; payload: string }[] {
  return getDb()
    .prepare(
      `SELECT kind, ts, payload_json AS payload FROM events
       WHERE kind IN ('dev.ready_to_merge','dev.merged','dev.changes_requested','dev.verify_failed')
       ORDER BY id ASC`
    )
    .all() as { kind: string; ts: string; payload: string }[]
}

export function eventCount(kind: string): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS n FROM events WHERE kind = ?').get(kind) as { n: number }
  ).n
}

export function commandVerificationTotals(): { passed: number; total: number } {
  return getDb()
    .prepare(
      `SELECT SUM(CASE WHEN status = 'pass' THEN 1 ELSE 0 END) AS passed,
              SUM(CASE WHEN status IN ('pass','fail') THEN 1 ELSE 0 END) AS total
       FROM task_verifications WHERE kind = 'command'`
    )
    .get() as { passed: number | null; total: number | null } as { passed: number; total: number }
}

// ──────────────────────────── review stats ────────────────────────────

export function reviewRecommendationTotals(): { recommendation: string; n: number }[] {
  return getDb()
    .prepare('SELECT recommendation, COUNT(*) AS n FROM reviews GROUP BY recommendation')
    .all() as { recommendation: string; n: number }[]
}

export function reviewActionTotals(): { action: string; n: number }[] {
  return getDb()
    .prepare("SELECT action, COUNT(*) AS n FROM reviews WHERE action IS NOT NULL GROUP BY action")
    .all() as { action: string; n: number }[]
}
