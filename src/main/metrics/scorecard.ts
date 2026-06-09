/**
 * Assemble the cost/quality scorecards (theme D) from the raw SQL aggregates in
 * ../store/metrics. Pure read; computes means/medians, parses task ids out of
 * `dev:<id>` work refs, and turns UTC datetime strings into elapsed minutes.
 * No token data — time / rework / outcome only.
 */
import * as store from '../store'
import type {
  DevThroughput,
  HarnessScorecard,
  MetricsSnapshot,
  ReviewStats
} from '@shared/types/domain'

/** Parse a SQLite `datetime('now')` UTC string to epoch ms. */
function parseUtc(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime()
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

function taskIdFromWorkRef(ref: string): number | null {
  const [kind, id] = ref.split(':')
  if (kind !== 'dev') return null
  const n = Number(id)
  return Number.isFinite(n) ? n : null
}

function buildHarnessScorecards(): HarnessScorecard[] {
  const aggs = store.metrics.harnessSessionAggregates()
  const durations = store.metrics.sessionDurations()
  const captured = store.metrics.reviewsCapturedByHarness()
  const recs = store.metrics.reviewRecommendationsByHarness()
  const names = new Map(store.listHarnesses().map((h) => [h.id, h.displayName]))

  const byHarnessDurations = new Map<string, number[]>()
  for (const d of durations) {
    if (!byHarnessDurations.has(d.harnessId)) byHarnessDurations.set(d.harnessId, [])
    byHarnessDurations.get(d.harnessId)!.push(d.minutes)
  }
  const capturedBy = new Map(captured.map((c) => [c.harnessId, c.n]))
  const recsBy = new Map<string, Record<string, number>>()
  for (const r of recs) {
    if (!recsBy.has(r.harnessId)) recsBy.set(r.harnessId, {})
    recsBy.get(r.harnessId)![r.recommendation] = r.n
  }

  return aggs
    .map((a): HarnessScorecard => {
      const mins = byHarnessDurations.get(a.harnessId) ?? []
      return {
        harnessId: a.harnessId,
        displayName: names.get(a.harnessId) ?? a.harnessId,
        sessionsTotal: a.sessionsTotal,
        sessionsDev: a.sessionsDev,
        sessionsReview: a.sessionsReview,
        avgSessionMinutes: mean(mins),
        medianSessionMinutes: median(mins),
        endedNeedsHuman: a.endedNeedsHuman,
        endedKilled: a.endedKilled,
        reviewsCaptured: capturedBy.get(a.harnessId) ?? 0,
        reviewRecommendations: recsBy.get(a.harnessId) ?? {}
      }
    })
    .sort((x, y) => y.sessionsTotal - x.sessionsTotal)
}

function buildDevThroughput(): DevThroughput {
  const merged = store.metrics.devMergedCounts()
  const starts = new Map<number, number>()
  for (const s of store.metrics.devTaskStartTimes()) {
    const id = taskIdFromWorkRef(s.workRef)
    if (id != null && s.startedAt) starts.set(id, parseUtc(s.startedAt))
  }

  const readyAt = new Map<number, number>() // first time a task became ready
  const mergedAt = new Map<number, number>()
  const reworkByTask = new Map<number, number>()
  for (const e of store.metrics.devLifecycleEvents()) {
    let taskId: number | undefined
    try {
      taskId = (JSON.parse(e.payload) as { taskId?: number }).taskId
    } catch {
      /* skip */
    }
    if (taskId == null) continue
    const ts = parseUtc(e.ts)
    if (e.kind === 'dev.ready_to_merge' && !readyAt.has(taskId)) readyAt.set(taskId, ts)
    else if (e.kind === 'dev.merged') mergedAt.set(taskId, ts)
    else if (e.kind === 'dev.changes_requested' || e.kind === 'dev.verify_failed') {
      reworkByTask.set(taskId, (reworkByTask.get(taskId) ?? 0) + 1)
    }
  }

  const timeToReady: number[] = []
  const timeToMerge: number[] = []
  const reworkPerMerged: number[] = []
  for (const [taskId, mergeTs] of mergedAt) {
    const start = starts.get(taskId)
    if (start != null) timeToMerge.push((mergeTs - start) / 60000)
    reworkPerMerged.push(reworkByTask.get(taskId) ?? 0)
  }
  for (const [taskId, ready] of readyAt) {
    const start = starts.get(taskId)
    if (start != null) timeToReady.push((ready - start) / 60000)
  }

  const cmd = store.metrics.commandVerificationTotals()
  const total = cmd.total ?? 0
  return {
    tasksMerged: merged.total ?? 0,
    tasksMerged7d: merged.d7 ?? 0,
    tasksMerged30d: merged.d30 ?? 0,
    avgTimeToReadyMinutes: mean(timeToReady),
    avgTimeToMergeMinutes: mean(timeToMerge),
    avgReworkCycles: mean(reworkPerMerged),
    resets: store.metrics.eventCount('dev.reset'),
    verificationPassRate: total > 0 ? (cmd.passed ?? 0) / total : null
  }
}

function buildReviewStats(): ReviewStats {
  const recs = store.metrics.reviewRecommendationTotals()
  const recommendations: Record<string, number> = {}
  let completed = 0
  for (const r of recs) {
    recommendations[r.recommendation] = r.n
    completed += r.n
  }
  const reviewMins = store.metrics
    .sessionDurations()
    .filter((d) => d.kind === 'review')
    .map((d) => d.minutes)
  const actions = store.metrics.reviewActionTotals()
  const acted = actions.reduce((a, b) => a + b.n, 0)
  const approved = actions.find((a) => a.action === 'approve')?.n ?? 0
  return {
    completed,
    recommendations,
    avgReviewMinutes: mean(reviewMins),
    humanApproveRate: acted > 0 ? approved / acted : null
  }
}

export function computeMetrics(): MetricsSnapshot {
  return {
    generatedAt: new Date().toISOString(),
    harnesses: buildHarnessScorecards(),
    dev: buildDevThroughput(),
    review: buildReviewStats()
  }
}
