import { log } from '../log'
import type { ProjectTracker, TrackerIssue, TransitionTarget } from './types'

/**
 * ShipReq (japgolly) adapter.
 *
 * ShipReq is a client-heavy app with no stable public API, so this adapter talks
 * to a configurable HTTP endpoint and maps the response defensively. Point it at
 * your ShipReq instance (or a thin proxy that exposes items as JSON). The exact
 * routes/shape below are reasonable assumptions — adjust to match your server.
 *
 * Expected item JSON (any subset; everything is optional and defensively read):
 *   { id|key, title|name|summary, status|state, assignee, priority,
 *     type|issueType, sprint|milestone, project|projectId }
 */
function authHeaders(token: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json' }
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

async function getJson(url: string, token: string, timeoutMs = 15_000): Promise<any> {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const resp = await fetch(url, { headers: authHeaders(token), signal: ac.signal })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return await resp.json()
  } finally {
    clearTimeout(t)
  }
}

const PRIORITY_WORDS: Record<string, number> = {
  highest: 5,
  high: 4,
  medium: 3,
  normal: 3,
  low: 2,
  lowest: 1
}

function mapItem(it: any): TrackerIssue {
  const project = it.project ?? it.projectId ?? it.projectKey ?? ''
  const rawPriority = it.priority
  const priority =
    typeof rawPriority === 'number'
      ? rawPriority
      : (PRIORITY_WORDS[String(rawPriority ?? '').toLowerCase()] ?? 3)
  return {
    key: String(it.key ?? it.id ?? ''),
    title: it.title ?? it.name ?? it.summary ?? '',
    status: it.status ?? it.state ?? 'To Do',
    assignee: it.assignee?.name ?? it.assignee ?? '',
    priority,
    issueType: it.type ?? it.issueType ?? 'Task',
    sprint: it.sprint ?? it.milestone ?? '',
    projectKey: String(typeof project === 'object' ? (project.key ?? project.id ?? '') : project),
    projectName:
      typeof project === 'object' ? (project.name ?? project.key ?? '') : String(project)
  }
}

export const shipreqTracker: ProjectTracker = {
  id: 'shipreq',

  async listAssigned(config): Promise<TrackerIssue[]> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base) return []
    const params = new URLSearchParams({ assignee: 'me' })
    if (config.project) params.set('project', config.project)
    if (config.query) params.set('q', config.query)
    const url = `${base}/api/items?${params.toString()}`
    const data = await getJson(url, config.token ?? '')
    const items: any[] = Array.isArray(data) ? data : (data.items ?? data.results ?? [])
    return items.map(mapItem)
  },

  async transition(key: string, target: TransitionTarget, config): Promise<void> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base) return
    log.info('transitioning shipreq item', { key, status: target })
    const resp = await fetch(`${base}/api/items/${encodeURIComponent(key)}/transition`, {
      method: 'POST',
      headers: { ...authHeaders(config.token ?? ''), 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: target })
    })
    if (!resp.ok) throw new Error(`shipreq transition ${key} -> ${target} failed: HTTP ${resp.status}`)
  },

  async checkAuth(config): Promise<{ ok: boolean; detail: string }> {
    const base = (config.endpoint ?? '').replace(/\/+$/, '')
    if (!base) return { ok: false, detail: 'no endpoint configured' }
    try {
      await getJson(`${base}/api/health`, config.token ?? '', 6000)
      return { ok: true, detail: base }
    } catch (err) {
      return { ok: false, detail: `${base}: ${String(err).slice(0, 80)}` }
    }
  }
}
