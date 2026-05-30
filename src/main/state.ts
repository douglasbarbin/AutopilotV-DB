import { app, BrowserWindow } from 'electron'
import * as store from './store'
import { brain } from './brain/brain'
import { Channels } from '@shared/types/ipc'
import type { AppState } from '@shared/types/domain'

export function buildState(): AppState {
  return {
    tasks: store.listTasks(),
    jiraProjects: store.listJiraProjects(),
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

let pushScheduled = false

/** Coalesce rapid state changes into a single push on the next tick. */
export function pushState(): void {
  if (pushScheduled) return
  pushScheduled = true
  setImmediate(() => {
    pushScheduled = false
    const state = buildState()
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(Channels.evtState, state)
    }
  })
}
