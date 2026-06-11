import { useCallback, useEffect, useState } from 'react'
import type { AppState } from '@shared/types/domain'
import { trackerDisplayName } from '@shared/types/trackers'
import { useAppState, useNotifications } from './useAppState'
import { WorkQueue } from './components/WorkQueue'
import { SessionGrid } from './components/SessionGrid'
import { ReviewCards } from './components/ReviewCards'
import { BacklogInsights } from './components/BacklogInsights'
import { RunningApps } from './components/RunningApps'
import { SettingsPanel } from './components/SettingsPanel'
import { EventsLog } from './components/EventsLog'
import { BrainPanel } from './components/BrainPanel'
import { MetricsPanel } from './components/MetricsPanel'
import { Onboarding } from './components/Onboarding'
import { About } from './components/About'
import { Icon } from './components/Icon'
import { Starfield } from './components/Starfield'
import { RightRail, type RailAction } from './components/RightRail'
import { TerminalRepoPicker } from './components/TerminalRepoPicker'
import { INTEGRATION_STATUS_COLOR } from './theme'
import logoUrl from '../../../build/icon.png'
import { api } from './api'
import type { NotificationPayload } from '@shared/types/ipc'

type Tab = 'work' | 'sessions' | 'reviews' | 'insights' | 'brain' | 'metrics' | 'events' | 'settings'

const NAV: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { id: 'work', label: 'Work Queue', icon: 'queue' },
  { id: 'sessions', label: 'Sessions', icon: 'sessions' },
  { id: 'reviews', label: 'Reviews', icon: 'reviews' },
  { id: 'insights', label: 'Backlog & Insights', icon: 'lightbulb' },
  { id: 'brain', label: 'Brain', icon: 'brain' },
  { id: 'metrics', label: 'Metrics', icon: 'chart' },
  { id: 'events', label: 'Activity', icon: 'activity' },
  { id: 'settings', label: 'Settings', icon: 'settings' }
]

export function App() {
  const state = useAppState()
  const [tab, setTab] = useState<Tab>('work')
  const [toast, setToast] = useState<NotificationPayload | null>(null)
  const [showAbout, setShowAbout] = useState(false)
  const [terminalPickerOpen, setTerminalPickerOpen] = useState(false)
  useEffect(() => api.onOpenAbout(() => setShowAbout(true)), [])
  useEffect(() => api.onTrayOpenSettings(() => setTab('settings')), [])

  const onNotify = useCallback((n: NotificationPayload) => {
    setToast(n)
    setTimeout(() => setToast(null), 6000)
  }, [])
  useNotifications(onNotify)

  // Apply the selected theme palette to the document root.
  useEffect(() => {
    document.documentElement.dataset.theme = state?.settings.theme ?? 'tomorrow-night-80s'
  }, [state?.settings.theme])

  if (!state) {
    return (
      <div className="loading">
        <img className="logo-img lg" src={logoUrl} alt="AutopilotV" />
        Loading AutopilotV…
      </div>
    )
  }

  const reviewCount = state.prReviews.filter((p) => p.state === 'awaiting_user').length
  const needsHuman = state.sessions.filter((s) => s.status === 'needs_human').length
  const activeSessions = state.sessions.filter((s) =>
    ['starting', 'running', 'stalled', 'needs_human'].includes(s.status)
  ).length
  const enabledProjects = new Set(state.trackerProjects.filter((p) => p.enabled).map((p) => p.key))
  const workCount =
    state.prReviews.filter((p) => !['submitted', 'dismissed', 'pruned', 'superseded'].includes(p.state)).length +
    state.tasks.filter((t) => t.status !== 'done' && enabledProjects.has(t.projectKey)).length

  const insightsCount =
    state.followups.filter((f) => f.status === 'candidate').length +
    state.knowledge.filter((k) => k.status === 'candidate').length

  const badges: Partial<Record<Tab, number>> = {
    work: workCount || undefined,
    sessions: activeSessions || undefined,
    reviews: reviewCount || undefined,
    insights: insightsCount || undefined
  }
  const titles: Record<Tab, string> = {
    work: 'Work Queue',
    sessions: 'Sessions',
    reviews: 'Reviews',
    insights: 'Backlog & Insights',
    brain: 'Brain',
    metrics: 'Metrics',
    events: 'Activity',
    settings: 'Settings'
  }

  const railActions: RailAction[] = [
    {
      id: 'terminal',
      label: 'Open terminal in repo…',
      icon: 'terminal',
      onClick: () => setTerminalPickerOpen(true)
    }
  ]

  return (
    <div className="app" style={{ position: 'relative', overflow: 'hidden' }}>
      <Starfield active={activeSessions > 0} />
      <aside className="sidebar">
        <div className="brand">
          <img className="logo-img" src={logoUrl} alt="AutopilotV" />
          <div className="brand-text">
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <strong>AutopilotV</strong>
              {activeSessions > 0 && (
                <span className="rocket-container" title="Autopilot active: driving tasks!">
                  <span className="rocket-ship">🚀</span>
                  <span className="rocket-fire" style={{ color: 'var(--orange)' }}>🔥</span>
                </span>
              )}
            </div>
            <span>mission control</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
            >
              <Icon name={item.icon} size={17} />
              <span>{item.label}</span>
              {badges[item.id] ? <span className="nav-badge">{badges[item.id]}</span> : null}
              {item.id === 'sessions' && needsHuman > 0 && (
                <span className="nav-badge alert">{needsHuman}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="integrations">
            {(['github', 'tracker', 'llm', 'localModel'] as const).map((name) => {
              const i = state.integrations.find((x) => x.name === name)
              const status = i?.status ?? 'unknown'
              const label =
                name === 'localModel'
                  ? 'local'
                  : name === 'tracker'
                    ? trackerDisplayName(state.settings.tracker)
                    : name
              return (
                <span className="integration" key={name} title={i?.detail ?? 'not checked'}>
                  <span className="status-dot" style={{ background: INTEGRATION_STATUS_COLOR[status] }} />
                  {label}
                </span>
              )
            })}
          </div>
          <button
            className={`brain-toggle ${state.brain.running ? 'on' : 'off'}`}
            onClick={() => void api.setBrainRunning(!state.brain.running)}
          >
            <Icon name={state.brain.running ? 'pause' : 'play'} size={14} />
            {state.brain.running ? 'Brain running' : 'Brain paused'}
          </button>
          <div className="attribution">
            <button className="attribution-link" onClick={() => setShowAbout(true)}>
              AutopilotV
            </button>
            <span> · MIT · © Justin Woodring</span>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1>{titles[tab]}</h1>
          <div className="topbar-right">
            <TickStatus brain={state.brain} />
            <button className="btn-soft" onClick={() => void api.tickNow()}>
              <Icon name="bolt" size={14} /> Tick now
            </button>
          </div>
        </header>

        <main className="page">
          {tab === 'work' && <WorkQueue state={state} />}
          {tab === 'sessions' && (
            <>
              <RunningApps state={state} />
              <SessionGrid sessions={state.sessions} theme={state.settings.theme} />
            </>
          )}
          {tab === 'reviews' && <ReviewCards state={state} />}
          {tab === 'insights' && <BacklogInsights state={state} />}
          {tab === 'brain' && <BrainPanel state={state} />}
          {tab === 'metrics' && <MetricsPanel />}
          {tab === 'events' && <EventsLog state={state} />}
          {tab === 'settings' && <SettingsPanel state={state} />}
        </main>
      </div>

      <RightRail actions={railActions} />

      {toast && (
        <div className={`toast ${toast.kind}`} onClick={() => setToast(null)}>
          <strong>{toast.title}</strong>
          <span>{toast.body}</span>
        </div>
      )}
      {!state.settings.onboarded && <Onboarding state={state} />}
      {showAbout && <About version={state.appVersion} onClose={() => setShowAbout(false)} />}
      {terminalPickerOpen && (
        <TerminalRepoPicker state={state} onClose={() => setTerminalPickerOpen(false)} />
      )}
    </div>
  )
}

function TickStatus({ brain }: { brain: AppState['brain'] }) {
  // Re-render every second so "Ns ago" stays live between state pushes.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <span className="tick-status">
      {brain.ticking ? (
        <>
          <span className="pulse" /> thinking…
        </>
      ) : brain.lastTickAt ? (
        `tick #${brain.tick} · ${timeAgo(brain.lastTickAt)}`
      ) : (
        'idle'
      )}
    </span>
  )
}

function timeAgo(iso: string): string {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
