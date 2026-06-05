import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api } from './api'
import type { AppState } from '@shared/types/domain'
import type { NotificationPayload, StateDelta, StateSlice } from '@shared/types/ipc'

/**
 * Single source of truth for the renderer's app state, with slice-level
 * subscriptions so each component re-renders only when its slice's
 * reference actually changes.
 *
 * Why this is a refcounted shared store instead of multiple useStates:
 *   - the underlying event source is one IPC subscription (`state.delta`)
 *   - components mount and unmount frequently as the user switches tabs
 *   - we want exactly one snapshot at boot, plus a single subscription
 *
 * Implementation: a tiny in-renderer store that holds the current AppState
 * and notifies subscribers. Each `useAppStateSlice('tasks')` adds itself to
 * a per-slice subscriber set, and re-renders only when its slice's
 * reference changes.
 */

type Listener = (state: AppState) => void

const sliceListeners = new Map<StateSlice, Set<Listener>>()
let current: AppState | null = null
let booted = false
let onDeltaSubscribed = false

function ensureBoot(): void {
  if (booted) return
  booted = true
  api.snapshot().then((s) => {
    current = s
    // First snapshot: notify every slice's listeners.
    for (const set of sliceListeners.values()) {
      for (const fn of set) fn(s)
    }
  })
  if (!onDeltaSubscribed) {
    onDeltaSubscribed = true
    api.onStateDelta((delta: StateDelta) => {
      current = delta.state
      for (const slice of delta.changed) {
        const set = sliceListeners.get(slice)
        if (!set) continue
        for (const fn of set) fn(delta.state)
      }
    })
  }
}

/**
 * Subscribe to a single slice of the AppState. Re-renders only when the
 * slice's reference changes (i.e. when main re-fetched and reassigned it).
 *
 * Returns the current value (or `null` before the first snapshot arrives).
 */
export function useAppStateSlice<K extends StateSlice>(
  slice: K
): AppState[K] | null {
  ensureBoot()
  const subscribe = (cb: Listener) => {
    let set = sliceListeners.get(slice)
    if (!set) {
      set = new Set()
      sliceListeners.set(slice, set)
    }
    set.add(cb)
    return () => {
      set?.delete(cb)
    }
  }
  const getSnapshot = (): AppState[K] | null => (current ? current[slice] : null)
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Legacy hook: the full AppState. Backwards-compatible — every consumer
 *  that previously did `useAppState()` will keep working, but every push
 *  re-renders them. New code should prefer `useAppStateSlice('tasks')` etc. */
export function useAppState(): AppState | null {
  // Compose the most common slices into a stable ref. Components using this
  // hook will still re-render on any push, but the hook itself is now a thin
  // shim over the slice store.
  ensureBoot()
  const ref = useRef<{ v: AppState | null; vTasks: AppState['tasks']; vSessions: AppState['sessions']; vReviews: AppState['prReviews']; vHarnesses: AppState['harnesses']; vRepos: AppState['repos']; vSettings: AppState['settings']; vEvents: AppState['events']; vBrainNotes: AppState['brainNotes']; vIntegrations: AppState['integrations']; vWorktrees: AppState['worktrees']; vProjects: AppState['trackerProjects']; vBrain: AppState['brain'] } | null>(null)
  const [state, setState] = useState<AppState | null>(ref.current?.v ?? null)

  useEffect(() => {
    const recompute = (s: AppState) => {
      if (
        ref.current &&
        ref.current.vTasks === s.tasks &&
        ref.current.vSessions === s.sessions &&
        ref.current.vReviews === s.prReviews &&
        ref.current.vHarnesses === s.harnesses &&
        ref.current.vRepos === s.repos &&
        ref.current.vSettings === s.settings &&
        ref.current.vEvents === s.events &&
        ref.current.vBrainNotes === s.brainNotes &&
        ref.current.vIntegrations === s.integrations &&
        ref.current.vWorktrees === s.worktrees &&
        ref.current.vProjects === s.trackerProjects &&
        ref.current.vBrain === s.brain
      ) {
        return // nothing changed for any slice the legacy hook cares about
      }
      ref.current = {
        v: s,
        vTasks: s.tasks,
        vSessions: s.sessions,
        vReviews: s.prReviews,
        vHarnesses: s.harnesses,
        vRepos: s.repos,
        vSettings: s.settings,
        vEvents: s.events,
        vBrainNotes: s.brainNotes,
        vIntegrations: s.integrations,
        vWorktrees: s.worktrees,
        vProjects: s.trackerProjects,
        vBrain: s.brain
      }
      setState(s)
    }
    const unsubs = [
      subscribeSlice('tasks', recompute),
      subscribeSlice('sessions', recompute),
      subscribeSlice('prReviews', recompute),
      subscribeSlice('harnesses', recompute),
      subscribeSlice('repos', recompute),
      subscribeSlice('settings', recompute),
      subscribeSlice('events', recompute),
      subscribeSlice('brainNotes', recompute),
      subscribeSlice('integrations', recompute),
      subscribeSlice('worktrees', recompute),
      subscribeSlice('trackerProjects', recompute),
      subscribeSlice('brain', recompute)
    ]
    if (current) recompute(current)
    return () => {
      for (const u of unsubs) u()
    }
  }, [])

  return state
}

function subscribeSlice(slice: StateSlice, cb: Listener): () => void {
  ensureBoot()
  let set = sliceListeners.get(slice)
  if (!set) {
    set = new Set()
    sliceListeners.set(slice, set)
  }
  set.add(cb)
  return () => {
    set?.delete(cb)
  }
}

export function useNotifications(onNotify: (n: NotificationPayload) => void): void {
  useEffect(() => api.onNotification(onNotify), [onNotify])
}
