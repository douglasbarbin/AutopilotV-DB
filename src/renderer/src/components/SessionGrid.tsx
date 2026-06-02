import { useState } from 'react'
import type { Session } from '@shared/types/domain'
import { TerminalView } from './TerminalView'
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
            onClick={() => setFocused(s.id)}
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
            <div className="toolbar-actions">
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
          <TerminalView key={focusedSession.id} sessionId={focusedSession.id} theme={theme} />
        </div>
      )}
    </div>
  )
}
