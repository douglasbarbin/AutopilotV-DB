import type { AppState, ReviewFinding } from '@shared/types/domain'
import { api } from '../api'

const SEV_COLOR: Record<string, string> = {
  info: 'var(--comment)',
  minor: 'var(--yellow)',
  major: 'var(--orange)',
  blocker: 'var(--red)'
}

export function ReviewCards({ state }: { state: AppState }) {
  // Latest review per pr_review that is awaiting action.
  const awaiting = state.prReviews.filter((p) => p.state === 'awaiting_user')
  const cards = awaiting
    .map((pr) => {
      const review = state.reviews
        .filter((r) => r.prReviewId === pr.id && !r.action)
        .sort((a, b) => b.id - a.id)[0]
      return review ? { pr, review } : null
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  if (cards.length === 0) {
    return <div className="empty">No reviews awaiting your approval.</div>
  }

  return (
    <div className="review-cards">
      {cards.map(({ pr, review }) => (
        <div className="review-card" key={review.id}>
          <div className="review-head">
            <span className="badge review">{review.recommendation.replace('_', ' ')}</span>
            <span className="review-title">
              #{pr.prNumber} {pr.title}
            </span>
            <span className="work-sub">{pr.repoName}</span>
          </div>
          <p className="review-summary">{review.summary}</p>
          {(review.findings as ReviewFinding[]).length > 0 && (
            <ul className="findings">
              {(review.findings as ReviewFinding[]).map((f, i) => (
                <li key={i}>
                  <span className="sev" style={{ color: SEV_COLOR[f.severity] }}>
                    {f.severity}
                  </span>
                  <code>
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </code>
                  <span>{f.note}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="review-actions">
            <button
              className="approve"
              title="Approve and post this summary as the review comment"
              onClick={() => void api.reviewAct(review.id, 'approve')}
            >
              Approve
            </button>
            <button
              className="approve-only"
              title="Approve with no comment posted"
              onClick={() => void api.approvePr(pr.id)}
            >
              Approve only
            </button>
            <button
              className="warn"
              onClick={() => void api.reviewAct(review.id, 'request_changes')}
            >
              Request changes
            </button>
            <button className="ghost" onClick={() => void api.reviewAct(review.id, 'comment')}>
              Comment
            </button>
            <button className="ghost" onClick={() => void api.reviewAct(review.id, 'dismiss')}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
