import { getDb } from './_db'
import type { PrReview, PrReviewState, ReviewSummary, ReviewAction } from '@shared/types/domain'

interface PrReviewRow {
  id: number
  pr_number: number
  repo_id: number
  title: string
  author: string
  branch: string
  url: string
  state: PrReviewState
  claim_state: string
  session_id: number | null
  discovered_at: string
  updated_at: string
  forge: string | null
}

function rowToPrReview(r: PrReviewRow): PrReview {
  // resolve the repo's name lazily via the repos table; this is one extra
  // SELECT per row. We accept that here because listPrReviews runs in buildState
  // and the number of PRs is small (dozens, not thousands).
  const repo = getDb().prepare('SELECT forge FROM repos WHERE id = ?').get(r.repo_id) as
    | { forge: string | null }
    | undefined
  return {
    id: r.id,
    prNumber: r.pr_number,
    repoId: r.repo_id,
    repoName: '', // legacy field; consumers compute it from getRepo() when needed
    title: r.title,
    author: r.author,
    branch: r.branch,
    url: r.url,
    state: r.state,
    claimState: r.claim_state as PrReview['claimState'],
    sessionId: r.session_id,
    discoveredAt: r.discovered_at,
    updatedAt: r.updated_at,
    forge: r.forge ?? repo?.forge ?? 'github'
  }
}

export function upsertPrReview(p: {
  prNumber: number
  repoId: number
  title: string
  author: string
  branch: string
  url: string
}): { review: PrReview; reRequested: boolean } {
  const prev = getPrReviewByNumber(p.repoId, p.prNumber)
  let reRequested = false
  if (prev?.state === 'submitted') {
    const last = getLatestReviewForPr(prev.id)
    reRequested = last?.action === 'approve' || last?.action === 'request_changes'
  }

  // The PR's forge is whichever forge owns its repo at write time. This is
  // what lets the renderer + the review orchestrator route calls to the
  // right adapter without consulting the (potentially stale) active setting.
  const repo = getDb().prepare('SELECT forge FROM repos WHERE id = ?').get(p.repoId) as
    | { forge: string | null }
    | undefined
  const forge = repo?.forge ?? 'github'

  getDb()
    .prepare(
      `INSERT INTO pr_reviews (pr_number, repo_id, title, author, branch, url, forge)
       VALUES (@pr_number, @repo_id, @title, @author, @branch, @url, @forge)
       ON CONFLICT(repo_id, pr_number) DO UPDATE SET
         title = @title, author = @author, branch = @branch, url = @url, forge = @forge, updated_at = datetime('now')`
    )
    .run({
      pr_number: p.prNumber,
      repo_id: p.repoId,
      title: p.title,
      author: p.author,
      branch: p.branch,
      url: p.url,
      forge
    })
  if (reRequested && prev) resetPrReview(prev.id)
  return { review: getPrReviewByNumber(p.repoId, p.prNumber)!, reRequested }
}

export function getPrReviewByNumber(repoId: number, prNumber: number): PrReview | null {
  const row = getDb()
    .prepare('SELECT * FROM pr_reviews WHERE repo_id = ? AND pr_number = ?')
    .get(repoId, prNumber) as PrReviewRow | undefined
  return row ? rowToPrReview(row) : null
}

export function getPrReview(id: number): PrReview | null {
  const row = getDb().prepare('SELECT * FROM pr_reviews WHERE id = ?').get(id) as
    | PrReviewRow
    | undefined
  return row ? rowToPrReview(row) : null
}

export function listPrReviews(): PrReview[] {
  const rows = getDb()
    .prepare('SELECT * FROM pr_reviews ORDER BY discovered_at DESC')
    .all() as PrReviewRow[]
  return rows.map(rowToPrReview)
}

export function setPrReviewState(id: number, state: PrReviewState): void {
  getDb()
    .prepare("UPDATE pr_reviews SET state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(state, id)
}

/** Reset a PR review back to discovered/unclaimed so it can be retried. */
export function resetPrReview(id: number): void {
  getDb()
    .prepare(
      `UPDATE pr_reviews
       SET state = 'discovered', claim_state = 'unclaimed', lease_owner = NULL,
           lease_expires_at = NULL, session_id = NULL, updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(id)
}

// ---- review summaries ----

interface ReviewRow {
  id: number
  pr_review_id: number
  recommendation: ReviewAction
  summary: string
  findings_json: string
  created_at: string
  action: ReviewAction | null
  acted_at: string | null
}

function rowToReview(r: ReviewRow): ReviewSummary {
  return {
    id: r.id,
    prReviewId: r.pr_review_id,
    recommendation: r.recommendation,
    summary: r.summary,
    findings: JSON.parse(r.findings_json),
    createdAt: r.created_at,
    action: r.action,
    actedAt: r.acted_at
  }
}

export function insertReview(r: {
  prReviewId: number
  recommendation: ReviewAction
  summary: string
  findings: unknown[]
}): number {
  const info = getDb()
    .prepare(
      `INSERT INTO reviews (pr_review_id, recommendation, summary, findings_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(r.prReviewId, r.recommendation, r.summary, JSON.stringify(r.findings))
  return Number(info.lastInsertRowid)
}

export function listReviews(): ReviewSummary[] {
  const rows = getDb().prepare('SELECT * FROM reviews ORDER BY created_at DESC').all() as ReviewRow[]
  return rows.map(rowToReview)
}

export function getLatestReviewForPr(prReviewId: number): ReviewSummary | null {
  const row = getDb()
    .prepare('SELECT * FROM reviews WHERE pr_review_id = ? ORDER BY created_at DESC LIMIT 1')
    .get(prReviewId) as ReviewRow | undefined
  return row ? rowToReview(row) : null
}

export function recordReviewAction(reviewId: number, action: ReviewAction): void {
  getDb()
    .prepare("UPDATE reviews SET action = ?, acted_at = datetime('now') WHERE id = ?")
    .run(action, reviewId)
}
