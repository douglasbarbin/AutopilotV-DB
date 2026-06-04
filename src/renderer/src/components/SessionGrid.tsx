import { useState } from 'react'
import type { Session } from '@shared/types/domain'
import { TerminalView } from './TerminalView'
import { DiffView } from './DiffView'
import { api } from '../api'

const STATUS_COLOR: Record<string, string> = {
  starting: 'var(--yellow)',
  running: 'var(--green)',
  stalled: 'var(--orange)',
  needs_human: 'var(--red)',
  exited: 'var(--comment)',
  killed: 'var(--comment)'
}

export function SessionGrid({ sessions, theme }: { sessions: Session[]; theme: string }) {
  const active = sessions.filter((s) =>
    ['starting', 'running', 'stalled', 'needs_human'].includes(s.status)
  )
  const [focused, setFocused] = useState<number | null>(null)
  const [viewMode, setViewMode] = useState<'terminal' | 'diff'>('terminal')
  const focusId = focused ?? active[0]?.id ?? null

  if (active.length === 0) {
    return <div className="empty">No live sessions. The brain will spawn sessions as work is claimed.</div>
  }

  const focusedSession = active.find((s) => s.id === focusId)

  return (
    <div className="session-grid">
      <div className="session-tabs">
        {active.map((s) => (
          <button
            key={s.id}
            className={`session-tab ${focusId === s.id ? 'active' : ''}`}
            onClick={() => {
              setFocused(s.id)
              setViewMode('terminal') // Reset view mode when switching sessions
            }}
          >
            <span className="dot" style={{ background: STATUS_COLOR[s.status] }} />
            <span className="tab-title">{s.title || s.workRef}</span>
            {s.autoDrive && <span className="tab-auto" title="auto-drive on">⤳</span>}
            <span className="tab-status">{s.status}</span>
          </button>
        ))}
      </div>
      {focusedSession && (
        <div className="session-pane">
          <div className="session-toolbar">
            <span>{focusedSession.title}</span>
            <div className="toolbar-actions" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <div className="session-mode-tabs" style={{ display: 'flex', gap: '4px', marginRight: '8px' }}>
                <button
                  className={`btn-soft ${viewMode === 'terminal' ? 'active' : ''}`}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    background: viewMode === 'terminal' ? 'var(--accent)' : '',
                    color: viewMode === 'terminal' ? '#1f1f1f' : ''
                  }}
                  onClick={() => setViewMode('terminal')}
                >
                  Terminal
                </button>
                <button
                  className={`btn-soft ${viewMode === 'diff' ? 'active' : ''}`}
                  style={{
                    padding: '5px 12px',
                    fontSize: '11px',
                    borderRadius: '4px',
                    background: viewMode === 'diff' ? 'var(--accent)' : '',
                    color: viewMode === 'diff' ? '#1f1f1f' : ''
                  }}
                  onClick={() => setViewMode('diff')}
                >
                  File Diff
                </button>
              </div>
              <button
                className={`toggle ${focusedSession.autoDrive ? 'on' : 'off'}`}
                title="Auto-drive: let the brain answer prompts and unstick this session"
                onClick={() => void api.setSessionAutoDrive(focusedSession.id, !focusedSession.autoDrive)}
              >
                <span
                  className="status-dot"
                  style={{ background: focusedSession.autoDrive ? 'var(--green)' : 'var(--comment)' }}
                />
                Auto-drive {focusedSession.autoDrive ? 'on' : 'off'}
              </button>
              <button className="danger" onClick={() => void api.killSession(focusedSession.id)}>
                Kill
              </button>
            </div>
          </div>
          {viewMode === 'terminal' ? (
            <TerminalView key={focusedSession.id} sessionId={focusedSession.id} theme={theme} />
          ) : (
            <DiffView key={focusedSession.id} worktreeId={focusedSession.worktreeId || undefined} />
          )}
        </div>
      )}
    </div>
  )
}
