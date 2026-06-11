import { log } from '../log'
import type { IssueDraft, ProjectTracker, TrackerIssue, TransitionTarget } from './types'

/**
 * Azure DevOps adapter.
 *
 * Talks to the Azure DevOps REST API using a Personal Access Token (PAT).
 * Docs: https://learn.microsoft.com/en-us/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate
 *
 * Auth is HTTP Basic with an empty username and the PAT as the password
 * (base64-encoded as `:PAT`). The token needs the "Work Items (Read & Write)"
 * scope at minimum; "Read" alone is enough for the queue, transitions need Write.
 *
 * Config fields (stored in settings.trackerConfig.azuredevops):
 *   org            — Azure DevOps organization name (the `dev.azure.com/{org}` slug)
 *   project        — (optional) Project name; leave blank to query across all projects
 *                    the PAT can see
 *   pat            — Personal Access Token
 *   assigneeFilter — (optional) Identity (email or unique name) to filter by;
 *                    defaults to the authenticated user via WIQL `@Me`
 */

function authHeader(pat: string): string {
  // PAT goes in the password slot of HTTP Basic; the username is blank.
  return 'Basic ' + Buffer.from(':' + pat).toString('base64')
}

async function apiFetch(
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  pat: string,
  body?: unknown,
  timeoutMs = 15_000
): Promise<any> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': method === 'PATCH' ? 'application/json-patch+json' : 'application/json',
        Authorization: authHeader(pat)
      },
      signal: ac.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
    }
    if (resp.status === 204) return null
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

/** WIT identity object → display string. */
function assigneeName(assignedTo: unknown): string {
  if (!assignedTo) return ''
  if (typeof assignedTo === 'string') return assignedTo
  const a = assignedTo as { displayName?: string; uniqueName?: string }
  return a.displayName ?? a.uniqueName ?? ''
}

/** Azure DevOps state names vary per process template; map to AutopilotV's buckets. */
function bucketState(state: string): string {
  const s = (state ?? '').trim().toLowerCase()
  if (!s) return 'To Do'
  if (/(closed|done|completed|removed|resolved|review)/.test(s)) return s.includes('review') ? 'In Review' : 'Done'
  if (/(active|doing|in dev|implement|progress)/.test(s)) return 'In Progress'
  if (/(new|to.?do|proposed|backlog|ready)/.test(s)) return 'To Do'
  return state // preserve the raw name
}

function mapWorkItem(wi: any): TrackerIssue {
  const f = wi.fields ?? {}
  const workItemType = f['System.WorkItemType'] ?? 'Task'
  const state = f['System.State'] ?? 'New'
  // Azure DevOps priority: 1=highest, 2,3,4=lowest. Invert to AutopilotV's 1..5
  // (higher = more important) so a 1 (urgent) maps to 5.
  const rawPriority = Number(f['System.Priority'] ?? 3)
  const priority = Math.max(1, Math.min(5, 6 - rawPriority))
  const project = f['System.TeamProject'] ?? ''
  return {
    key: String(wi.id ?? ''),
    title: f['System.Title'] ?? '',
    status: bucketState(state),
    assignee: assigneeName(f['System.AssignedTo']),
    priority,
    issueType: workItemType,
    sprint: f['System.IterationPath'] ?? '',
    projectKey: project,
    projectName: project
  }
}

function isClosedState(state: string): boolean {
  return /^(closed|done|completed|removed|cut)$/i.test((state ?? '').trim())
}

export const azureDevOpsTracker: ProjectTracker = {
  id: 'azuredevops',
  capabilities: { createIssue: true },

  async listAssigned(config): Promise<TrackerIssue[]> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    if (!org || !pat) return []
    const project = (config.project ?? '').trim()
    const base = `https://dev.azure.com/${encodeURIComponent(org)}`
    const projectPath = project ? `/${encodeURIComponent(project)}` : ''
    const assigneeFilter = (config.assigneeFilter ?? '').trim()

    // Build the WIQL assignee clause. Prefer an explicit filter, else @Me.
    // Azure DevOps is the one tracker where "@Me" reliably resolves through WIQL
    // and short-circuits the need to look up the current user identity first.
    const assigneeClause = assigneeFilter
      ? `[System.AssignedTo] = '${assigneeFilter.replace(/'/g, "''")}'`
      : `[System.AssignedTo] = @Me`

    const wiql = `SELECT [System.Id] FROM workitems WHERE ${assigneeClause} AND [System.State] <> 'Closed' AND [System.WorkItemType] <> 'Epic' ORDER BY [System.ChangedDate] DESC`

    const wiqlUrl = project
      ? `${base}${projectPath}/_apis/wit/wiql?api-version=7.1-preview.2`
      : // Cross-project WIQL lives under the org root, not under a project.
        `${base}/_apis/wit/wiql?api-version=7.1-preview.2`

    const wiqlResp = await apiFetch('POST', wiqlUrl, pat, { query: wiql })
    const ids: number[] = Array.isArray(wiqlResp?.workItems)
      ? wiqlResp.workItems.map((w: any) => Number(w.id)).filter((n: number) => Number.isFinite(n))
      : []
    if (ids.length === 0) return []

    // WIQL returns just IDs; the work-items endpoint gives us the fields.
    // The endpoint is paged (default 200), which is plenty for a personal queue.
    const detailUrl = project
      ? `${base}${projectPath}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.1-preview.3&$expand=None`
      : `${base}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.1-preview.3&$expand=None`

    const itemsResp = await apiFetch('GET', detailUrl, pat)
    // Azure DevOps REST returns collections wrapped in { value: [...] }.
    const items: any[] = Array.isArray(itemsResp)
      ? itemsResp
      : Array.isArray(itemsResp?.value)
        ? itemsResp.value
        : []

    return items
      .filter((wi) => !isClosedState(wi?.fields?.['System.State']))
      .map(mapWorkItem)
  },

  async transition(key: string, target: TransitionTarget, config): Promise<void> {
    const org = (config.org ?? '').trim()
    const project = (config.project ?? '').trim()
    const pat = config.pat ?? ''
    if (!org || !pat) {
      log.warn('azuredevops transition skipped: missing org or pat', { key })
      return
    }
    if (!project) {
      // PATCH against the cross-project endpoint needs a ?project= query param,
      // and projects may use different process templates / state names; without
      // a project we can't reliably build the right URL.
      log.info('azuredevops transition skipped: no project configured', { key, target })
      return
    }
    // Map AutopilotV lifecycle targets to the Agile-process state names. Scrum
    // and Basic share "Active"/"Resolved" for the first two, but their "Done"
    // state is "Closed" (Agile/Scrum) or "Done" (Basic) — we map to the most
    // common ("Active"/"Closed") and let the server reject on mismatch.
    const newState = target === 'In Progress' ? 'Active' : 'Closed'
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`
    const url = `${base}/_apis/wit/workitems/${encodeURIComponent(key)}?api-version=7.1-preview.3`
    log.info('transitioning azure devops work item', { key, target, newState })
    try {
      await apiFetch('PATCH', url, pat, [
        { op: 'add', path: '/fields/System.State', value: newState }
      ])
    } catch (err) {
      // Best-effort: Azure DevOps state names are process-template-specific,
      // and the user's board may not even have "Active"/"Closed". Surface the
      // failure for the audit log but don't crash the tick.
      log.warn('azuredevops transition failed (process template may use different state names)', {
        key,
        newState,
        err: String(err).slice(0, 160)
      })
    }
  },

  async checkAuth(config): Promise<{ ok: boolean; detail: string }> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    if (!org) return { ok: false, detail: 'no organization set in Tracker settings' }
    if (!pat) return { ok: false, detail: 'no PAT set in Tracker settings' }
    // List the projects visible to the PAT — covers both auth validity and that
    // the org slug resolves. Lightweight and works for both org-scoped and
    // project-scoped tokens.
    const url = `https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?api-version=7.1-preview.4`
    try {
      const r = await apiFetch('GET', url, pat, undefined, 6000)
      const count = Array.isArray(r?.value) ? r.value.length : 0
      return { ok: true, detail: `dev.azure.com/${org} (${count} project${count === 1 ? '' : 's'})` }
    } catch (err) {
      return { ok: false, detail: `dev.azure.com/${org}: ${String(err).slice(0, 120)}` }
    }
  },

  async createIssue(draft: IssueDraft, config): Promise<{ key: string; url?: string }> {
    const org = (config.org ?? '').trim()
    const pat = config.pat ?? ''
    const project = (draft.projectKey || config.project || '').trim()
    if (!org || !pat) throw new Error('azuredevops org/pat not configured')
    if (!project) throw new Error('no Azure DevOps project to create the work item in')
    const patch = (title: string, description: string) => [
      { op: 'add', path: '/fields/System.Title', value: title },
      { op: 'add', path: '/fields/System.Description', value: description }
    ]
    const base = `https://dev.azure.com/${encodeURIComponent(org)}/${encodeURIComponent(project)}`
    const create = async (type: string): Promise<any> => {
      // Work-item creation is POST with a json-patch body — its own fetch here
      // because the shared apiFetch keys content-type off the method.
      const url = `${base}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=7.1-preview.3`
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json-patch+json',
          Authorization: authHeader(pat)
        },
        body: JSON.stringify(patch(draft.title, draft.description || draft.title))
      })
      if (!resp.ok) {
        const text = await resp.text().catch(() => '')
        throw new Error(`HTTP ${resp.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
      }
      return resp.json()
    }
    // Work-item type names are process-template-specific; fall back to Task.
    const preferred = draft.kind === 'bug' ? 'Bug' : 'Task'
    let created: any
    try {
      created = await create(preferred)
    } catch (err) {
      if (preferred === 'Task') throw err
      log.warn('azuredevops create failed for type; retrying as Task', {
        type: preferred,
        err: String(err).slice(0, 120)
      })
      created = await create('Task')
    }
    const id = created?.id
    if (!id) throw new Error('azuredevops work item create returned no id')
    return { key: String(id), url: created?._links?.html?.href ?? undefined }
  }
}
