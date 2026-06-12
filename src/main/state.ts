import { app, BrowserWindow } from 'electron'
import * as store from './store'
import { brain } from './brain/brain'
import { appInstances } from './apps/instances'
import { getActiveVerification } from './dev/pipeline'
import type { StateDelta, StateSlice } from '@shared/types/ipc'
import type { AppState } from '@shared/types/domain'

/**
 * Builds the AppState working set and pushes deltas to the renderer.
 *
 * History:
 *   Originally this was `buildState()` re-running 9 unbounded SQL queries on
 *   every IPC handler call, sending the full state twice (evt.state +
 *   state.delta), and marking EVERY slice changed on every push (fresh array
 *   references made the old `!==` comparison always true) — so the renderer
 *   re-rendered the whole tree on every push regardless of what changed.
 *
 *   Now:
 *   - the store queries are bounded to the working set (open work, live
 *     sessions/worktrees, recent history), so push cost stops growing with
 *     the lifetime of the database;
 *   - `computeDelta()` compares slice CONTENT (serialized) and reuses the
 *     previous object reference for unchanged slices, so `delta.changed` is
 *     accurate and the renderer's slice subscribers only re-render when their
 *     data actually changed;
 *   - only `state.delta` is sent — nothing listened on the legacy full-state
 *     channel, and sending both doubled IPC serialization. `buildState()` is
 *     still used by `snapshot()` at boot.
 */

export function buildState(): AppState {
  return {
    tasks: store.listTasks(),
    trackerProjects: store.listTrackerProjects(),
    prReviews: store.listPrReviews(),
    reviews: store.listReviews(),
    taskVerifications: store.listRecentVerifications(),
    sessions: store.listSessions(),
    worktrees: store.listLiveWorktrees(),
    harnesses: store.listHarnesses(),
    repos: store.listRepos(),
    integrations: store.getIntegrationHealth(),
    settings: store.getSettings(),
    events: store.listEvents(200),
    brainNotes: store.listBrainNotes(200),
    followups: store.listFollowUpsForState(),
    knowledge: store.listKnowledgeForState(),
    appInstances: appInstances.list(),
    activeVerification: getActiveVerification(),
    appVersion: app.getVersion(),
    brain: brain.state
  }
}

const SLICES: StateSlice[] = [
  'tasks',
  'trackerProjects',
  'prReviews',
  'reviews',
  'taskVerifications',
  'sessions',
  'worktrees',
  'harnesses',
  'repos',
  'integrations',
  'settings',
  'events',
  'brainNotes',
  'followups',
  'knowledge',
  'appInstances',
  'activeVerification',
  'brain'
]

let lastState: AppState | null = null
const sliceJson = new Map<StateSlice, string>()
let pushScheduled = false

/**
 * Mark slices as changed since the last push. Kept as the call-site API;
 * the dirty set itself is derived in computeDelta from slice content, which
 * also catches writes that forgot to mark anything.
 */
export function markDirty(...slices: StateSlice[]): void {
  pushState()
  void slices
}

/** Coalesce rapid state changes into a single push on the next tick. */
export function pushState(): void {
  if (pushScheduled) return
  pushScheduled = true
  setImmediate(() => {
    pushScheduled = false
    try {
      const delta = computeDelta(buildState())
      if (delta.changed.length === 0) return // nothing actually changed
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('state.delta', delta)
      }
    } catch (err) {
      // Thrown on a later event-loop tick, so no caller can catch it — e.g.
      // background jobs pushing under a partial electron mock in tests.
      console.warn('state push failed', err)
    }
  })
}

function computeDelta(fresh: AppState): StateDelta {
  const changed: StateSlice[] = []
  const state = { ...fresh }
  for (const k of SLICES) {
    const json = JSON.stringify(fresh[k] ?? null)
    if (lastState && sliceJson.get(k) === json) {
      // Same content: keep the previous reference so slice subscribers'
      // reference comparison (and React memoization) sees "unchanged".
      ;(state as Record<StateSlice, unknown>)[k] = (lastState as Record<StateSlice, unknown>)[k]
    } else {
      sliceJson.set(k, json)
      changed.push(k)
    }
  }
  lastState = state
  return { version: 1, changed, state }
}
