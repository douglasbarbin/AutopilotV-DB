import { log } from '../log'
import type { ProjectTracker, TrackerIssue, TransitionTarget } from './types'

/**
 * Vikunja adapter.
 *
 * Talks directly to the Vikunja REST API using a personal API token.
 * Docs: https://vikunja.io/docs/api/
 *
 * Verified against Vikunja v2.3.0. Non-obvious things to know:
 *   - GET /api/v1/tasks/all returns 400 ("Invalid model") on this version.
 *     The correct "all tasks I can see" endpoint is GET /api/v1/tasks.
 *   - Tasks are commonly unassigned (assignees is null). An unassigned task is
 *     only "mine" if I created it. A task I created but explicitly assigned to
 *     someone else is NOT mine — we must look at the assignee list, not the
 *     creator, to decide whose queue a task belongs in. (Earlier versions
 *     conflated the two and would happily start implementing work that
 *     belonged to a teammate.)
 *   - Task updates are POST /api/v1/tasks/{id} (PUT returns 405 — the route
 *     only allows OPTIONS/DELETE/GET/POST).
 *   - Moving a task to a Kanban column is a SEPARATE call from setting
 *     percent_done. The endpoint is
 *     POST /api/v1/projects/{pid}/views/{vid}/buckets/{bid}/tasks
 *     with body {"task_id": <id>}. The task's `bucket_id` field is a
 *     derived/legacy value and is not what controls the board position.
 *
 * Config fields (stored in settings.trackerConfig.vikunja):
 *   endpoint       — Base URL, e.g. https://vikunja.example.com
 *   token          — Personal API token (Vikunja → Settings → API Tokens)
 *   projectId      — (optional) Restrict to a single project ID
 *   assigneeFilter — (optional) Filter by this username; defaults to the current user
 *
 * Assignee resolution: a task is included in "assigned to me" only when EITHER
 *   (a) the task has an assignees[] list and the current user is in it, OR
 *   (b) the task has no assignees (assignees is null/missing/empty) and the
 *       current user is the creator (an unassigned task I filed).
 * If the current user cannot be resolved (neither assigneeFilter nor /user
 * yields a username), listAssigned throws — better to surface the misconfig
 * than to silently enqueue every task the token can see.
 */

const MAX_PER_PAGE = 50

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

async function apiFetchWithHeaders(
  method: string,
  url: string,
  token: string,
  body?: unknown,
  timeoutMs = 15_000
): Promise<{ body: any; totalPages: number }> {
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
    const totalPages = Number(resp.headers.get('x-pagination-total-pages') ?? '1') || 1
    const data = resp.status === 204 ? null : await resp.json()
    return { body: data, totalPages }
  } finally {
    clearTimeout(timer)
  }
}

/** Walk every page of a paginated list endpoint and return the flattened array. */
async function fetchAllPages(
  method: 'GET',
  buildUrl: (page: number) => string,
  token: string
): Promise<any[]> {
  const first = await apiFetchWithHeaders(method, buildUrl(1), token)
  const firstArr = Array.isArray(first.body) ? first.body : []
  if (first.totalPages <= 1) return firstArr
  const rest: any[][] = await Promise.all(
    Array.from({ length: first.totalPages - 1 }, (_, i) =>
      apiFetch(method, buildUrl(i + 2), token).then((b) => (Array.isArray(b) ? b : []))
    )
  )
  return firstArr.concat(...rest)
}

function taskAssignees(task: any): { username: string; name: string }[] {
  if (!Array.isArray(task.assignees)) return []
  return task.assignees
    .map((a: any) => ({ username: a?.username ?? '', name: a?.name ?? '' }))
    .filter((a: { username: string; name: string }) => a.username || a.name)
}

function taskCreatorUsername(task: any): string {
  return task?.created_by?.username ?? ''
}

function primaryAssignee(task: any): string {
  const as = taskAssignees(task)
  if (as.length > 0) return as[0].username || as[0].name
  return taskCreatorUsername(task)
}

/**
 * True iff `task` is genuinely "assigned to me" under Vikunja's data model.
 *
 * A task is mine when EITHER:
 *   - the task has an assignees[] list and my username is in it, OR
 *   - the task is unassigned (no assignees at all) and I am the creator —
 *     i.e. an unfiled ticket I created that nobody has picked up.
 *
 * A task I created but explicitly assigned to a teammate is NOT mine, even
 * though the old code would surface it. The assignee list is the source of
 * truth, not the creator field.
 */
function isAssignedToUser(task: any, username: string): boolean {
  if (!username) return false
  const as = taskAssignees(task)
  if (as.length > 0) return as.some((a) => a.username === username)
  return taskCreatorUsername(task) === username
}

function mapTask(task: any, projectNameById: Map<number, string>): TrackerIssue {
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

  const rawPriority = task.priority ?? 0
  const priority = rawPriority === 0 ? 3 : rawPriority

  const sprint: string = Array.isArray(task.labels)
    ? (task.labels.find((l: any) => /sprint|milestone/i.test(l.title ?? ''))?.title ?? '')
    : ''

  const projectId = String(task.project_id ?? '')
  const projectName = projectId ? (projectNameById.get(Number(projectId)) ?? projectId) : ''

  return {
    key: String(task.id ?? ''),
    title: task.title ?? '',
    status,
    assignee: primaryAssignee(task),
    priority,
    issueType: 'Task',
    sprint,
    projectKey: projectId,
    projectName
  }
}

/** Fetch every project the token can see and return id → title. Best-effort. */
async function fetchProjectNameMap(base: string, token: string): Promise<Map<number, string>> {
  const byId = new Map<number, string>()
  try {
    const data = await apiFetch('GET', `${base}/api/v1/projects?per_page=${MAX_PER_PAGE}`, token)
    if (Array.isArray(data)) {
      for (const p of data) {
        const id = Number(p?.id)
        const title = p?.title
        if (Number.isFinite(id) && title) byId.set(id, title)
      }
    }
  } catch {
    /* projects list is best-effort */
  }
  return byId
}

/** Resolve the authenticated user via /api/v1/user. Throws on upstream errors;
 *  callers that want best-effort behavior should wrap this themselves. */
async function fetchCurrentUsername(base: string, token: string): Promise<string> {
  const me = await apiFetch('GET', `${base}/api/v1/user`, token)
  return me?.username ?? ''
}

/**
 * Resolve the username to filter the assigned-tasks queue by. Order of
 * preference: explicit `assigneeFilter` config, then the authenticated user
 * looked up via /api/v1/user. Throws if neither yields a username — surfacing
 * a misconfig beats silently returning every task the token can see.
 */
async function resolveMyUsername(base: string, token: string, assigneeFilter: string): Promise<string> {
  const explicit = (assigneeFilter ?? '').trim()
  if (explicit) return explicit
  const me = await fetchCurrentUsername(base, token)
  if (!me) throw new Error('could not resolve the authenticated Vikunja user (no username on /user)')
  return me
}

/** A kanban bucket title we treat as "in flight" — In Progress / Doing / WIP. */
const IN_FLIGHT_BUCKET = /\b(in[\s_-]?progress|doing|wip|work\s*in\s*progress|working)\b/i

export const vikunjaTracker: ProjectTracker = {
  id: 'vikunja',

  async listAssigned(config): Promise<TrackerIssue[]> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base || !config.token) return []

    const token = config.token
    const projectId = config.projectId ?? ''
    const projectNameById = await fetchProjectNameMap(base, token)
    // Throws if the username can't be resolved — see resolveMyUsername. That's
    // the correct failure mode: it surfaces a misconfigured token/upstream to
    // the brain, rather than silently enqueueing tasks assigned to other users.
    const username = await resolveMyUsername(base, token, config.assigneeFilter ?? '')

    const tasks = projectId
      ? await fetchAllPages('GET', (p) =>
          `${base}/api/v1/projects/${encodeURIComponent(projectId)}/tasks?per_page=${MAX_PER_PAGE}&page=${p}`
        , token)
      : await fetchAllPages('GET', (p) =>
          `${base}/api/v1/tasks?per_page=${MAX_PER_PAGE}&page=${p}`
        , token)

    return tasks
      .filter((t: any) => !t.done)
      .filter((t: any) => isAssignedToUser(t, username))
      .map((t: any) => mapTask(t, projectNameById))
  },

  async transition(key: string, target: TransitionTarget, config): Promise<void> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base || !config.token) return
    log.info('transitioning vikunja task', { key, target })

    // Look up the task → its project → the project's kanban view → the
    // "In Progress / Doing" bucket, then add the task to that bucket.
    // The bucket move is what makes the card visibly change columns on the
    // board. percent_done alone does not move the card.
    let projectId: number | null = null
    try {
      const task = await apiFetch('GET', `${base}/api/v1/tasks/${encodeURIComponent(key)}`, config.token)
      const pid = Number(task?.project_id)
      if (Number.isFinite(pid) && pid > 0) projectId = pid
    } catch (err) {
      log.warn('vikunja: failed to fetch task before transition', { key, err: String(err) })
    }

    if (projectId != null) {
      try {
        const views = await apiFetch(
          'GET',
          `${base}/api/v1/projects/${projectId}/views`,
          config.token
        )
        const kanban = Array.isArray(views) ? views.find((v: any) => v?.view_kind === 'kanban') : null
        if (kanban?.id) {
          const buckets = await apiFetch(
            'GET',
            `${base}/api/v1/projects/${projectId}/views/${kanban.id}/buckets`,
            config.token
          )
          const inFlight = Array.isArray(buckets)
            ? buckets.find((b: any) => typeof b?.title === 'string' && IN_FLIGHT_BUCKET.test(b.title))
            : null
          if (inFlight?.id) {
            await apiFetch(
              'POST',
              `${base}/api/v1/projects/${projectId}/views/${kanban.id}/buckets/${inFlight.id}/tasks`,
              config.token,
              { task_id: Number(key) }
            )
            log.info('vikunja: moved task to bucket', { key, bucket: inFlight.title, bucketId: inFlight.id })
          } else {
            log.warn('vikunja: no in-flight bucket found in kanban view', { key, projectId, viewId: kanban.id })
          }
        } else {
          log.warn('vikunja: project has no kanban view; skipping bucket move', { key, projectId })
        }
      } catch (err) {
        log.warn('vikunja: bucket move failed; falling back to percent_done only', { key, err: String(err) })
      }
    }

    // Always set percent_done so mapTask's status derivation matches the
    // bucket move. The kanban has no separate "In Review" column, so both
    // targets land in "In Progress"; percent_done is the only signal that
    // distinguishes the two.
    const percentDone = target === 'In Progress' ? 0.5 : 0.75
    await apiFetch('POST', `${base}/api/v1/tasks/${encodeURIComponent(key)}`, config.token, {
      done: false,
      percent_done: percentDone
    })
  },

  async checkAuth(config): Promise<{ ok: boolean; detail: string }> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base) return { ok: false, detail: 'no endpoint configured' }
    if (!config.token) return { ok: false, detail: 'no API token configured' }
    try {
      const username = await fetchCurrentUsername(base, config.token)
      return { ok: true, detail: username ? `${base} (${username})` : `${base}` }
    } catch (err) {
      return { ok: false, detail: `${base}: ${String(err).slice(0, 80)}` }
    }
  }
}
