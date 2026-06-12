import { useMemo, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { ActiveVerification, AppState, PrReview, TaskVerification, TrackerTask } from '@shared/types/domain'
import { api } from '../api'
import { DiffView } from './DiffView'
import { TYPE_COLOR, taskStateLabel } from '../theme'

// Stable empty array so rows without verifications don't get a fresh prop each render.
const NO_VERIFICATIONS: TaskVerification[] = []

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
  // One pass instead of an O(tasks × verifications) filter per row.
  const verificationsByTask = useMemo(() => {
    const m = new Map<number, TaskVerification[]>()
    for (const v of state.taskVerifications) {
      const list = m.get(v.taskId)
      if (list) list.push(v)
      else m.set(v.taskId, [v])
    }
    return m
  }, [state.taskVerifications])

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
            verifications={verificationsByTask.get(t.id) ?? NO_VERIFICATIONS}
            active={state.activeVerification?.taskId === t.id ? state.activeVerification : null}
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

const STAGE_ORDER: TaskVerification['kind'][] = ['setup', 'secrets', 'build', 'test', 'app', 'e2e']
const STAGE_MARK: Record<TaskVerification['status'], string> = {
  pass: '✓',
  fail: '✗',
  error: '⚠',
  skipped: '–'
}

/**
 * Verification line: lives BELOW the state line. Shows the live "verifying
 * now" pulse while this task's pipeline is executing, then one chip per stage
 * with its latest verdict.
 */
function VerifyLine({
  verifications,
  active
}: {
  verifications: TaskVerification[]
  active: ActiveVerification | null
}) {
  const [inspect, setInspect] = useState<TaskVerification | null>(null)
  const cmd = verifications.find((v) => v.kind === 'command')
  const spec = verifications.find((v) => v.kind === 'spec')
  const stages = STAGE_ORDER.map((k) => verifications.find((v) => v.kind === k)).filter(
    (v): v is TaskVerification => !!v
  )

  if (!active && !cmd && !spec && stages.length === 0) return null
  const label: Record<TaskVerification['status'], string> = {
    pass: '✓ verified',
    fail: '✗ verify failed',
    error: '⚠ verify error',
    skipped: 'verify skipped'
  }

  const chips: ReactNode[] = []
  if (active) {
    chips.push(
      <span key="active" className="state-tag verifying" title={`pipeline running since ${active.startedAt}`}>
        <span className="pulse-dot" /> verifying now — {active.stage} ({active.checkpoint.replace('_', ' ')})
      </span>
    )
  }
  for (const v of stages) {
    // While a stage is live, the live chip speaks for it.
    if (active && v.kind === active.stage) continue
    chips.push(
      <button
        key={v.kind}
        className="state-tag chip-btn"
        style={{ color: VERIFY_COLOR[v.status] }}
        title={`[${v.checkpoint}] ${v.summary} — click for details`}
        onClick={() => setInspect(v)}
      >
        {STAGE_MARK[v.status]} {v.kind}
      </button>
    )
  }
  if (stages.length === 0 && cmd) {
    chips.push(
      <button
        key="cmd"
        className="state-tag chip-btn"
        style={{ color: VERIFY_COLOR[cmd.status] }}
        title={`${cmd.summary} — click for details`}
        onClick={() => setInspect(cmd)}
      >
        {label[cmd.status]}
      </button>
    )
  }
  if (spec && spec.status === 'fail') {
    chips.push(
      <button
        key="spec"
        className="state-tag chip-btn"
        style={{ color: 'var(--orange)' }}
        title={`${spec.summary} — click for details`}
        onClick={() => setInspect(spec)}
      >
        spec concerns
      </button>
    )
  }

  return (
    <span className="work-sub verify-line">
      {chips.map((c, i) => (
        <span key={i} className="verify-chip">
          {c}
        </span>
      ))}
      {inspect && <VerificationDetail v={inspect} onClose={() => setInspect(null)} />}
    </span>
  )
}

/** Stage drill-down: what ran, what it said, and where the evidence lives. */
function VerificationDetail({ v, onClose }: { v: TaskVerification; onClose: () => void }) {
  const d = v.detail as { command?: string; output?: string; log?: string; artifacts?: string[]; gate?: string }
  const output = d.output ?? d.log ?? ''
  // Portal to <body>: cards have backdrop-filter (own stacking context) and a
  // hover transform (becomes the fixed-position containing block), so rendering
  // in place leaves the modal trapped behind sibling cards and mis-anchored.
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal app-logs" onClick={(e) => e.stopPropagation()}>
        <div className="runbook-head">
          <strong style={{ color: VERIFY_COLOR[v.status] }}>
            {STAGE_MARK[v.status]} {v.kind} — {v.status}
          </strong>
          <span className="work-sub">
            {v.checkpoint.replace('_', ' ')} · {v.commitSha.slice(0, 7)} · {v.createdAt}
            {d.gate ? ` · gate: ${d.gate}` : ''}
          </span>
          <button className="btn-soft" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="review-summary">{v.summary}</p>
        {d.command && (
          <p className="review-summary">
            <code>{d.command}</code>
          </p>
        )}
        {(d.artifacts?.length ?? 0) > 0 && (
          <p className="review-summary">
            Evidence: {d.artifacts!.map((a) => <code key={a}>{a} </code>)}
          </p>
        )}
        <pre>{output || '(no output captured)'}</pre>
      </div>
    </div>,
    document.body
  )
}

function TaskRow({
  task,
  autoPublish,
  verifications,
  active
}: {
  task: TrackerTask
  autoPublish: boolean
  verifications: TaskVerification[]
  active: ActiveVerification | null
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
          {(task.phase === 'in_review' || task.phase === 'ready_to_merge') &&
            task.reviewersRequested > 0 && (
              <span
                className="reviewer-chip"
                title={`${task.approvals} of ${task.reviewersRequested} assigned reviewer(s) approved`}
                style={{
                  color:
                    task.approvals >= task.reviewersRequested
                      ? 'var(--green)'
                      : task.approvals > 0
                        ? 'var(--yellow)'
                        : 'var(--comment)'
                }}
              >
                {' · '}⊙ {task.approvals}/{task.reviewersRequested} approved
              </span>
            )}
        </span>
        {['draft', 'in_review', 'ready_to_merge'].includes(task.phase) && (
          <VerifyLine verifications={verifications} active={active} />
        )}
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
        <TaskMenu task={task} showDiff={showDiff} onToggleDiff={() => setShowDiff((v) => !v)} />
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


/**
 * Secondary task actions collapsed behind one button — the action bar was
 * growing to 8-10 visible buttons by the in_review phase. Primary, phase-
 * defining actions (Start/Publish/Merge/Retry/Request changes) stay visible;
 * utilities live here.
 */
function TaskMenu({
  task,
  showDiff,
  onToggleDiff
}: {
  task: TrackerTask
  showDiff: boolean
  onToggleDiff: () => void
}) {
  const [open, setOpen] = useState(false)
  const items: { label: string; danger?: boolean; run: () => void }[] = []
  if (task.prNumber != null || task.worktreeId != null) {
    items.push({ label: showDiff ? 'Hide diff' : 'View diff', run: onToggleDiff })
  }
  if (task.worktreeId != null && task.phase !== 'done') {
    items.push({ label: 'Open terminal', run: () => void api.openTerminal(task.id) })
  }
  if (['implementing', 'in_review', 'revising'].includes(task.phase)) {
    items.push({ label: 'Reset task…', danger: true, run: () => void api.resetDev(task.id) })
  }
  if (items.length === 0) return null
  return (
    <span className="task-menu">
      <button className="btn-ghost task-menu-btn" title="More actions" onClick={() => setOpen((v) => !v)}>
        ⋯
      </button>
      {open && (
        <>
          <span className="task-menu-backdrop" onClick={() => setOpen(false)} />
          <span className="task-menu-pop">
            {items.map((it) => (
              <button
                key={it.label}
                className={`task-menu-item ${it.danger ? 'danger' : ''}`}
                onClick={() => {
                  setOpen(false)
                  it.run()
                }}
              >
                {it.label}
              </button>
            ))}
          </span>
        </>
      )}
    </span>
  )
}
