import { log } from '../log'
import type { ProjectTracker, TrackerIssue, TransitionTarget } from './types'

/**
 * Vikunja adapter.
 *
 * Talks directly to the Vikunja REST API using a personal API token.
 * Docs: https://vikunja.io/docs/api/
 *
 * Config fields (stored in settings.trackerConfig.vikunja):
 *   endpoint       — Base URL, e.g. https://vikunja.example.com
 *   token          — Personal API token (Vikunja → Settings → API Tokens)
 *   projectId      — (optional) Restrict to a single project ID
 *   assigneeFilter — (optional) Filter by this username; defaults to the authenticated user
 */

function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function apiFetch(
  method: string,
  url: string,
  token: string,
  body?: unknown,
  timeoutMs = 15_000
): Promise<any> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: authHeaders(token),
      signal: ac.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    if (resp.status === 204) return null
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

function mapTask(task: any): TrackerIssue {
  // Derive a status string from Vikunja's done + percent_done fields
  let status: string
  if (task.done) {
    status = 'Done'
  } else if ((task.percent_done ?? 0) >= 0.75) {
    status = 'In Review'
  } else if ((task.percent_done ?? 0) >= 0.25) {
    status = 'In Progress'
  } else {
    status = 'To Do'
  }

  // Vikunja priority: 0 = unset → treat as 3 (medium); 1–5 map directly to AutopilotV's scale
  const rawPriority = task.priority ?? 0
  const priority = rawPriority === 0 ? 3 : rawPriority

  const assignee: string =
    Array.isArray(task.assignees) && task.assignees.length > 0
      ? (task.assignees[0].username ?? task.assignees[0].name ?? '')
      : ''

  // Sprint: first label whose title looks like a sprint or milestone marker
  const sprint: string = Array.isArray(task.labels)
    ? (task.labels.find((l: any) => /sprint|milestone/i.test(l.title ?? ''))?.title ?? '')
    : ''

  return {
    key: String(task.id ?? ''),
    title: task.title ?? '',
    status,
    assignee,
    priority,
    issueType: 'Task',
    sprint,
    projectKey: String(task.project_id ?? ''),
    projectName: String(task.project_id ?? '')
  }
}

export const vikunjaTracker: ProjectTracker = {
  id: 'vikunja',

  async listAssigned(config): Promise<TrackerIssue[]> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base || !config.token) return []

    const token = config.token
    const projectId = config.projectId ?? ''
    const assigneeFilter = config.assigneeFilter ?? ''

    // Resolve username: prefer explicit config, otherwise ask Vikunja who we are
    let username = assigneeFilter
    if (!username) {
      try {
        const me = await apiFetch('GET', `${base}/api/v1/user`, token, undefined, 6000)
        username = me?.username ?? ''
      } catch {
        // Fall through — list all accessible tasks without assignee filter
      }
    }

    let tasks: any[]
    if (projectId) {
      const data = await apiFetch(
        'GET',
        `${base}/api/v1/projects/${encodeURIComponent(projectId)}/tasks?per_page=100`,
        token
      )
      tasks = Array.isArray(data) ? data : []
    } else {
      const data = await apiFetch('GET', `${base}/api/v1/tasks/all?per_page=100`, token)
      tasks = Array.isArray(data) ? data : []
    }

    return tasks
      .filter((t: any) => !t.done)
      .filter((t: any) => {
        if (!username) return true
        return (
          Array.isArray(t.assignees) &&
          t.assignees.some((a: any) => (a.username ?? '') === username)
        )
      })
      .map(mapTask)
  },

  async transition(key: string, target: TransitionTarget, config): Promise<void> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base || !config.token) return
    log.info('transitioning vikunja task', { key, target })
    // Map AutopilotV lifecycle targets to Vikunja percent_done milestones
    const percentDone = target === 'In Progress' ? 0.5 : 0.75
    await apiFetch('PUT', `${base}/api/v1/tasks/${encodeURIComponent(key)}`, config.token, {
      done: false,
      percent_done: percentDone
    })
  },

  async checkAuth(config): Promise<{ ok: boolean; detail: string }> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base) return { ok: false, detail: 'no endpoint configured' }
    if (!config.token) return { ok: false, detail: 'no API token configured' }
    try {
      const me = await apiFetch('GET', `${base}/api/v1/user`, config.token, undefined, 6000)
      const username = me?.username ?? 'unknown'
      return { ok: true, detail: `${base} (${username})` }
    } catch (err) {
      return { ok: false, detail: `${base}: ${String(err).slice(0, 80)}` }
    }
  }
}
