import { useState } from 'react'
import type { AppState, FollowUp, KnowledgeItem } from '@shared/types/domain'
import { api } from '../api'

const KIND_COLOR: Record<string, string> = {
  todo: 'var(--comment)',
  tech_debt: 'var(--yellow)',
  bug: 'var(--red)',
  enhancement: 'var(--green)',
  test_gap: 'var(--orange)'
}

const CONF_COLOR: Record<string, string> = {
  low: 'var(--comment)',
  medium: 'var(--yellow)',
  high: 'var(--green)'
}

/**
 * Backlog & Insights: the human gate of the PM loop. Follow-ups harvested from
 * agent reports and post-merge analysis become tracker stories on an explicit
 * click; candidate learnings become active (injected into future sessions'
 * AGENTS.md) or are retired.
 */
export function BacklogInsights({ state }: { state: AppState }) {
  const candidates = state.followups.filter((f) => f.status === 'candidate')
  // Display window only — created rows are kept forever in the DB because the
  // semantic dedupe uses them to suppress re-suggestions of shipped stories.
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const created = state.followups
    .filter((f) => f.status === 'created' && Date.parse(f.updatedAt.replace(' ', 'T') + 'Z') > weekAgo)
    .slice(0, 10)
  const candidateKnowledge = state.knowledge.filter((k) => k.status === 'candidate')
  const activeKnowledge = state.knowledge.filter((k) => k.status === 'active')

  const empty =
    candidates.length === 0 &&
    created.length === 0 &&
    candidateKnowledge.length === 0 &&
    activeKnowledge.length === 0

  if (empty) {
    return (
      <div className="empty">
        Nothing here yet. As tasks merge, AutopilotV harvests follow-up work items and learned
        conventions from agent reports, PR conversations, and the code itself — they show up here
        for your review.
      </div>
    )
  }

  return (
    <div className="insights">
      <section>
        <h2 className="section-title">
          Follow-ups {candidates.length > 0 && <span className="nav-badge">{candidates.length}</span>}
        </h2>
        {candidates.length === 0 && <div className="empty">No follow-up candidates right now.</div>}
        <div className="review-cards">
          {candidates.map((f) => (
            <FollowUpCard key={f.id} f={f} state={state} />
          ))}
        </div>
        {created.length > 0 && (
          <div className="muted-list">
            <h3 className="section-sub">Recently created stories (last 7 days)</h3>
            <ul className="findings">
              {created.map((f) => (
                <li key={f.id}>
                  <code>{f.createdIssueKey}</code>
                  <span>{f.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2 className="section-title">
          Learnings{' '}
          {candidateKnowledge.length > 0 && <span className="nav-badge">{candidateKnowledge.length}</span>}
        </h2>
        {candidateKnowledge.length === 0 && (
          <div className="empty">No new learnings awaiting review.</div>
        )}
        <div className="review-cards">
          {candidateKnowledge.map((k) => (
            <KnowledgeCard key={k.id} k={k} state={state} candidate />
          ))}
        </div>
        {activeKnowledge.length > 0 && (
          <>
            <h3 className="section-sub">
              Active knowledge (injected into new sessions' AGENTS.md)
            </h3>
            <div className="review-cards">
              {activeKnowledge.map((k) => (
                <KnowledgeCard key={k.id} k={k} state={state} />
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function FollowUpCard({ f, state }: { f: FollowUp; state: AppState }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(f.title)
  const [description, setDescription] = useState(f.description)
  const [projectKey, setProjectKey] = useState(f.projectKey)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const repo = f.repoId ? state.repos.find((r) => r.id === f.repoId) : null
  const projects = state.trackerProjects

  const save = async () => {
    await api.updateFollowUp(f.id, { title, description, projectKey })
    setEditing(false)
  }

  const createStory = async () => {
    setBusy(true)
    setError('')
    try {
      if (editing) await save()
      await api.createStoryFromFollowUp(f.id)
    } catch (err) {
      setError(String(err).replace(/^.*Error: /, '').slice(0, 200))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="review-card">
      <div className="review-head">
        <span className="badge review" style={{ color: KIND_COLOR[f.kind] }}>
          {f.kind.replace('_', ' ')}
        </span>
        {editing ? (
          <input className="inline-edit" value={title} onChange={(e) => setTitle(e.target.value)} />
        ) : (
          <span className="review-title">{f.title}</span>
        )}
        <span className="work-sub">
          {f.priority} · {f.issueKey || repo?.name || ''} · via {f.source}
        </span>
      </div>
      {editing ? (
        <textarea
          className="inline-edit"
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      ) : (
        f.description && <p className="review-summary">{f.description}</p>
      )}
      {f.files.length > 0 && (
        <p className="review-summary">
          <code>{f.files.join(', ')}</code>
        </p>
      )}
      {editing && projects.length > 0 && (
        <label className="inline-label">
          Project{' '}
          <select value={projectKey} onChange={(e) => setProjectKey(e.target.value)}>
            <option value="">(none)</option>
            {projects.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name || p.key}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <p className="review-summary" style={{ color: 'var(--red)' }}>{error}</p>}
      <div className="review-actions">
        <button className="approve" disabled={busy} onClick={() => void createStory()}>
          {busy ? 'Creating…' : 'Create story'}
        </button>
        {editing ? (
          <button className="btn-ghost" onClick={() => void save()}>
            Save
          </button>
        ) : (
          <button className="btn-ghost" onClick={() => setEditing(true)}>
            Edit
          </button>
        )}
        <button className="btn-ghost" onClick={() => void api.setFollowUpStatus(f.id, 'dismissed')}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

function KnowledgeCard({ k, state, candidate = false }: { k: KnowledgeItem; state: AppState; candidate?: boolean }) {
  const repo = k.repoId ? state.repos.find((r) => r.id === k.repoId) : null
  return (
    <div className="review-card">
      <div className="review-head">
        <span className="badge review" style={{ color: CONF_COLOR[k.confidence] }}>
          {k.role} · {k.confidence}
        </span>
        <span className="review-title">{k.insight}</span>
        <span className="work-sub">
          {k.scope === 'global' ? 'global' : (repo?.name ?? k.projectKey ?? '')}
          {k.hitCount > 0 && ` · used ${k.hitCount}×`}
        </span>
      </div>
      {k.evidence && (
        <p className="review-summary">
          ref: <code>{k.evidence}</code>
        </p>
      )}
      <div className="review-actions">
        {candidate ? (
          <>
            <button className="approve" onClick={() => void api.setKnowledgeStatus(k.id, 'active')}>
              Accept
            </button>
            <button className="btn-ghost" onClick={() => void api.setKnowledgeStatus(k.id, 'retired')}>
              Reject
            </button>
          </>
        ) : (
          <button className="btn-ghost" onClick={() => void api.setKnowledgeStatus(k.id, 'retired')}>
            Retire
          </button>
        )}
      </div>
    </div>
  )
}
