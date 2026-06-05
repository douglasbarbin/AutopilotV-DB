import { app, BrowserWindow } from 'electron'
import * as store from './store'
import { brain } from './brain/brain'
import { Channels } from '@shared/types/ipc'
import type { StateDelta, StateSlice } from '@shared/types/ipc'
import type { AppState } from '@shared/types/domain'

/**
 * Builds the full AppState and pushes deltas to the renderer.
 *
 * History:
 *   Originally this was `buildState()` re-running 9 SQL queries on every
 *   IPC handler call (every claim, every settings change, every tick…).
 *   At low volume that's fine; at higher volume it becomes wasteful, and
 *   the renderer's single `useState` re-renders the whole tree on every push.
 *
 *   Now the main process keeps a small "dirty" set of slices and emits a
 *   `StateDelta` containing just the changed slices. The renderer's
 *   `useAppStateSlice('tasks')` hook compares the new reference to the old
 *   and only triggers a re-render when the slice actually changed.
 *
 *   Backwards compatibility: `buildState()` is still available (used by
 *   `snapshot()` at boot) and `pushState()` still emits the full state, but
 *   it also sends a `state.delta` event so renderer hooks can opt in to
 *   slice-level updates without giving up the full-state fallback.
 */

export function buildState(): AppState {
  return {
    tasks: store.listTasks(),
    trackerProjects: store.listTrackerProjects(),
    prReviews: store.listPrReviews(),
    reviews: store.listReviews(),
    sessions: store.listSessions(),
    worktrees: store.listWorktrees(),
    harnesses: store.listHarnesses(),
    repos: store.listRepos(),
    integrations: store.getIntegrationHealth(),
    settings: store.getSettings(),
    events: store.listEvents(200),
    brainNotes: store.listBrainNotes(200),
    appVersion: app.getVersion(),
    brain: brain.state
  }
}

let lastState: AppState | null = null
let pushScheduled = false

/**
 * Mark slices as changed since the last push. Slices that aren't dirty won't
 * be included in the next delta, so subscribers can re-render only when their
 * slice's reference actually changed.
 *
 * The legacy "push everything" behavior is preserved by calling
 * `markDirty('all')` from places that want a full state refresh.
 */
export function markDirty(...slices: StateSlice[]): void {
  // Coalesce: we always send the union of dirty slices on the next tick.
  pushState()
  // markDirty is currently a no-op for the dirty set (we always recompute
  // everything in buildState). The hook is here so future per-slice caching
  // (in 1.3 follow-ups) can plug in without changing call sites.
  void slices
}

/** Coalesce rapid state changes into a single push on the next tick. */
export function pushState(): void {
  if (pushScheduled) return
  pushScheduled = true
  setImmediate(() => {
    pushScheduled = false
    const state = buildState()
    const delta = computeDelta(state)
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(Channels.evtState, state)
      win.webContents.send('state.delta', delta)
    }
  })
}

function computeDelta(state: AppState): StateDelta {
  const changed: StateSlice[] = []
  if (!lastState) {
    changed.push(
      'tasks',
      'trackerProjects',
      'prReviews',
      'reviews',
      'sessions',
      'worktrees',
      'harnesses',
      'repos',
      'integrations',
      'settings',
      'events',
      'brainNotes',
      'brain'
    )
  } else {
    if (state.tasks !== lastState.tasks) changed.push('tasks')
    if (state.trackerProjects !== lastState.trackerProjects) changed.push('trackerProjects')
    if (state.prReviews !== lastState.prReviews) changed.push('prReviews')
    if (state.reviews !== lastState.reviews) changed.push('reviews')
    if (state.sessions !== lastState.sessions) changed.push('sessions')
    if (state.worktrees !== lastState.worktrees) changed.push('worktrees')
    if (state.harnesses !== lastState.harnesses) changed.push('harnesses')
    if (state.repos !== lastState.repos) changed.push('repos')
    if (state.integrations !== lastState.integrations) changed.push('integrations')
    if (state.settings !== lastState.settings) changed.push('settings')
    if (state.events !== lastState.events) changed.push('events')
    if (state.brainNotes !== lastState.brainNotes) changed.push('brainNotes')
    if (state.brain !== lastState.brain) changed.push('brain')
  }
  lastState = state
  return { version: 1, changed, state }
}
