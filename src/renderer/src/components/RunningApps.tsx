import { useState } from 'react'
import type { AppInstance, AppState } from '@shared/types/domain'
import { api } from '../api'

const STATUS_COLOR: Record<AppInstance['status'], string> = {
  starting: 'var(--yellow)',
  ready: 'var(--green)',
  exited: 'var(--comment)',
  failed: 'var(--red)'
}

/**
 * Compact registry of apps started from repo runbooks (pipeline verification
 * or a manual Run app) — visible next to the terminals so it's obvious what's
 * occupying ports and CPU, with one-click stop.
 */
export function RunningApps({ state }: { state: AppState }) {
  const [logs, setLogs] = useState<{ id: string; text: string } | null>(null)
  const instances = state.appInstances
  if (instances.length === 0) return null

  const showLogs = async (id: string) => {
    const text = await api.getAppInstanceLogs(id)
    setLogs({ id, text: text || '(no output captured)' })
  }

  return (
    <div className="running-apps">
      <h3 className="section-sub">Running apps</h3>
      {instances.map((a) => (
        <div className="running-app-row" key={a.id}>
          <span className="status-dot" style={{ background: STATUS_COLOR[a.status] }} />
          <strong>{a.repoName}</strong>
          <span className="work-sub">
            {a.id}
            {a.taskId ? ` · task #${a.taskId}` : ''} · {a.status}
            {Object.entries(a.ports).length > 0 &&
              ` · ${Object.entries(a.ports)
                .map(([n, p]) => `${n}:${p}`)
                .join(' ')}`}
          </span>
          {a.readyUrl && (
            <a href={a.readyUrl} target="_blank" rel="noreferrer" className="btn-soft">
              Open
            </a>
          )}
          <button className="btn-soft" onClick={() => void showLogs(a.id)}>
            Logs
          </button>
          <button className="btn-soft" onClick={() => void api.stopAppInstance(a.id)}>
            Stop
          </button>
        </div>
      ))}
      {logs && (
        <div className="modal-backdrop" onClick={() => setLogs(null)}>
          <div className="modal app-logs" onClick={(e) => e.stopPropagation()}>
            <div className="runbook-head">
              <strong>{logs.id}</strong>
              <button className="btn-soft" onClick={() => setLogs(null)}>
                Close
              </button>
            </div>
            <pre>{logs.text}</pre>
          </div>
        </div>
      )}
    </div>
  )
}
