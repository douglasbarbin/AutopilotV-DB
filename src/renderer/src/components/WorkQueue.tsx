import { useState } from 'react'
import type { AppState, PrReview, TaskVerification, TrackerTask } from '@shared/types/domain'
import { api } from '../api'
import { DiffView } from './DiffView'
import { TYPE_COLOR, taskStateLabel } from '../theme'

const VERIFY_COLOR: Record<TaskVerification['status'], string> = {
  pass: 'var(--green)',
  fail: 'var(--red)',
  error: 'var(--orange)',
  skipped: 'var(--comment)'
}

export function WorkQueue({ state }: { state: AppState }) {
  const openReviews = state.prReviews.filter(
    (p) => !['submitted', 'dismissed', 'pruned', 'superseded'].includes(p.state)
  )
  const enabled = new Set(state.trackerProjects.filter((p) => p.enabled).map((p) => p.key))
  const openTasks = state.tasks.filter(
    (t) => t.phase !== 'done' && t.issueType.toLowerCase() !== 'epic' && enabled.has(t.projectKey)
  )
  const sprint = openTasks.find((t) => t.sprint)?.sprint
  const autoPublish = state.settings.autoPublish

  return (
    <div className="work-queue">
      <section className="queue-col">
        <div className="col-head">
          <h3>PRs awaiting my review</h3>
          <span className="count-pill">{openReviews.length}</span>
        </div>
        {openReviews.length === 0 && <div className="empty">Nothing to review right now.</div>}
        {openReviews.map((p) => (
          <ReviewRow key={`r${p.id}`} p={p} />
        ))}
      </section>

      <section className="queue-col">
        <div className="col-head">
          <h3>Tasks assigned to me</h3>
          {sprint ? <span className="sprint-pill">{sprint}</span> : <span className="count-pill">{openTasks.length}</span>}
        </div>

        {state.trackerProjects.length > 0 && (
          <div className="project-filter">
            <span className="project-filter-label">Projects</span>
            {state.trackerProjects.map((p) => (
              <button
                key={p.key}
                className={`project-chip ${p.enabled ? 'on' : 'off'}`}
                title={`${p.name} (${p.key}) — ${p.openCount} open · click to ${p.enabled ? 'hide' : 'show'}`}
                onClick={() => void api.toggleTrackerProject(p.key, !p.enabled)}
              >
                <span className="project-chip-dot" />
                {p.name || p.key}
                {p.openCount > 0 && <span className="project-chip-count">{p.openCount}</span>}
              </button>
            ))}
          </div>
        )}

        {openTasks.length === 0 && (
          <div className="empty">No tasks in enabled projects for the current sprint. Epics are excluded.</div>
        )}
        {openTasks.map((t) => (
          <TaskRow
            key={`t${t.id}`}
            task={t}
            autoPublish={autoPublish}
            verifications={state.taskVerifications.filter((v) => v.taskId === t.id)}
          />
        ))}
      </section>
    </div>
  )
}

function ReviewRow({ p }: { p: PrReview }) {
  const [showDiff, setShowDiff] = useState(false)
  return (
    <div className={`card work-item task-card ${p.state === 'error' ? 'errored' : ''}`}>
      <div className="work-main">
        <div className="work-title-row">
          <span className="chip pr">PR #{p.prNumber}</span>
          <span className="work-title">{p.title}</span>
        </div>
        <span className="work-sub">
          {p.repoName} · opened by {p.author} ·{' '}
          <span className={`state-tag ${p.state === 'error' ? 'error' : ''}`}>
            {p.state.replace(/_/g, ' ')}
          </span>
        </span>
      </div>
      <div className="work-actions">
        {p.prNumber != null && p.repoId != null && (
          <button className={`btn-ghost ${showDiff ? 'active' : ''}`} onClick={() => setShowDiff(!showDiff)}>
            {showDiff ? 'Hide Diff' : 'Diff'}
          </button>
        )}
        {p.state === 'discovered' && (
          <>
            <button className="btn-primary" onClick={() => void api.claim({ kind: 'review', id: p.id })}>
              Review
            </button>
            <button className="btn-ghost" onClick={() => void api.skip({ kind: 'review', id: p.id })}>
              Skip
            </button>
          </>
        )}
        {p.state === 'error' && (
          <>
            <button className="btn-primary" onClick={() => void api.resetReview(p.id)}>
              Retry
            </button>
            <button className="btn-ghost" onClick={() => void api.skip({ kind: 'review', id: p.id })}>
              Dismiss
            </button>
          </>
        )}
      </div>
      {showDiff && (
        <div className="collapsible-diff-drawer">
          <DiffView prNumber={p.prNumber} repoId={p.repoId} />
        </div>
      )}
    </div>
  )
}

function VerifyBadge({ verifications }: { verifications: TaskVerification[] }) {
  const cmd = verifications.find((v) => v.kind === 'command')
  const spec = verifications.find((v) => v.kind === 'spec')
  if (!cmd && !spec) return null
  const label: Record<TaskVerification['status'], string> = {
    pass: '✓ verified',
    fail: '✗ verify failed',
    error: '⚠ verify error',
    skipped: 'verify skipped'
  }
  return (
    <>
      {cmd && (
        <span className="state-tag" style={{ color: VERIFY_COLOR[cmd.status] }} title={cmd.summary}>
          {' · '}
          {label[cmd.status]}
        </span>
      )}
      {spec && spec.status === 'fail' && (
        <span className="state-tag" style={{ color: 'var(--orange)' }} title={spec.summary}>
          {' · '}spec concerns
        </span>
      )}
    </>
  )
}

function TaskRow({
  task,
  autoPublish,
  verifications
}: {
  task: TrackerTask
  autoPublish: boolean
  verifications: TaskVerification[]
}) {
  const typeColor = TYPE_COLOR[task.issueType] ?? 'var(--comment)'
  // Reflect the real tracker status while unclaimed; show AutopilotV's phase once it's driving.
  const driving = task.phase !== 'unclaimed'
  const { label, color } = taskStateLabel(driving, task.phase, task.trackerStatus, task.status)
  const claimable = task.phase === 'unclaimed' && task.status === 'todo'
  // Take over anything in flight (In Progress / In Review) that AutopilotV isn't already driving.
  const takeoverable = task.phase === 'unclaimed' && task.status !== 'todo' && task.status !== 'done'
  const [requesting, setRequesting] = useState(false)
  const [text, setText] = useState('')
  const [takingOver, setTakingOver] = useState(false)
  const [prNum, setPrNum] = useState('')
  const [showDiff, setShowDiff] = useState(false)
  const submitRequest = () => {
    if (text.trim()) void api.requestDevChanges(task.id, text)
    setText('')
    setRequesting(false)
  }
  const submitTakeover = () => {
    const n = prNum.trim() ? Number(prNum.trim()) : undefined
    void api.delegate({ kind: 'dev', id: task.id }, n)
    setPrNum('')
    setTakingOver(false)
  }
  return (
    <div className={`card work-item task-card ${task.phase === 'error' ? 'errored' : ''}`}>
      <div className="work-main">
        <div className="work-title-row">
          <span className="chip type" style={{ color: typeColor, borderColor: typeColor }}>
            {task.issueType}
          </span>
          <span className="chip key">{task.issueKey}</span>
          <span className="work-title">{task.title}</span>
        </div>
        <span className="work-sub">
          <span className="state-tag" style={{ color }}>
            {label}
          </span>
          {driving && task.trackerStatus && (
            <span className="tracker-status"> · Tracker: {task.trackerStatus}</span>
          )}
          {task.prNumber ? (
            <>
              {' · '}
              <a className="pr-link" href={task.prUrl} target="_blank" rel="noreferrer">
                PR #{task.prNumber}
              </a>
            </>
          ) : null}
          {task.phase === 'implementing' && ' · working…'}
          {task.phase === 'in_review' && ' · babysitting'}
          {(task.phase === 'in_review' || task.phase === 'ready_to_merge') && (
            <VerifyBadge verifications={verifications} />
          )}
        </span>
      </div>
      <div className="work-actions">
        {claimable && (
          <>
            <button className="btn-primary" onClick={() => void api.claim({ kind: 'dev', id: task.id })}>
              Start
            </button>
            <button className="btn-ghost" onClick={() => void api.skip({ kind: 'dev', id: task.id })}>
              Skip
            </button>
          </>
        )}
        {takeoverable && (
          <>
            <button
              className="btn-primary"
              title="Claim this in-flight task — adopts its PR if one exists"
              onClick={() => setTakingOver((v) => !v)}
            >
              Take over
            </button>
            <button className="btn-ghost" onClick={() => void api.skip({ kind: 'dev', id: task.id })}>
              Skip
            </button>
          </>
        )}
        {task.phase === 'draft' && !autoPublish && (
          <button className="btn-primary" onClick={() => void api.publishDev(task.id)}>
            Publish
          </button>
        )}
        {task.phase === 'draft' && autoPublish && (
          <span className="muted-action">auto-publishing…</span>
        )}
        {(task.phase === 'draft' || task.phase === 'in_review') && (
          <button className="btn-ghost" onClick={() => setRequesting((v) => !v)}>
            Request changes
          </button>
        )}
        {task.phase === 'revising' && <span className="muted-action">revising…</span>}
        {task.phase === 'ready_to_merge' && (
          <button className="btn-primary" onClick={() => void api.mergeDev(task.id)}>
            Merge
          </button>
        )}
        {task.phase === 'error' && (
          <>
            <button className="btn-primary" onClick={() => void api.resetDev(task.id)}>
              Retry
            </button>
            <button className="btn-ghost" onClick={() => void api.skip({ kind: 'dev', id: task.id })}>
              Skip
            </button>
          </>
        )}
        {(task.prNumber != null || task.worktreeId != null) && (
          <button
            className={`btn-ghost ${showDiff ? 'active' : ''}`}
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? 'Hide Diff' : 'Diff'}
          </button>
        )}
        {task.worktreeId != null && task.phase !== 'done' && (
          <button
            className="btn-ghost"
            title="Open a kitty terminal in this worktree"
            onClick={() => void api.openTerminal(task.id)}
          >
            Terminal
          </button>
        )}
        {(task.phase === 'implementing' || task.phase === 'in_review' || task.phase === 'revising') && (
          <button className="btn-ghost" onClick={() => void api.resetDev(task.id)}>
            Reset
          </button>
        )}
      </div>
      {takingOver && (
        <div className="request-form takeover-form">
          <label className="takeover-label">
            Take over {task.issueKey} (tracker: {task.trackerStatus || task.status}). AutopilotV adopts an
            existing PR if it can find one — give it a number below to be explicit.
          </label>
          <input
            className="pr-input"
            type="text"
            inputMode="numeric"
            autoFocus
            value={prNum}
            placeholder="PR # to adopt (optional — leave blank to auto-detect)"
            onChange={(e) => setPrNum(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && submitTakeover()}
          />
          <div className="request-actions">
            <button className="btn-primary" onClick={submitTakeover}>
              Take over
            </button>
            <button className="btn-ghost" onClick={() => { setTakingOver(false); setPrNum('') }}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {requesting && (
        <div className="request-form">
          <textarea
            rows={3}
            autoFocus
            value={text}
            placeholder="Describe the changes to make to the draft (committed & pushed to the PR)…"
            onChange={(e) => setText(e.target.value)}
          />
          <div className="request-actions">
            <button className="btn-primary" disabled={!text.trim()} onClick={submitRequest}>
              Send to agent
            </button>
            <button className="btn-ghost" onClick={() => setRequesting(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {showDiff && (
        <div className="collapsible-diff-drawer">
          <DiffView worktreeId={task.worktreeId || undefined} prNumber={task.prNumber || undefined} repoId={task.repoId || undefined} />
        </div>
      )}
    </div>
  )
}
