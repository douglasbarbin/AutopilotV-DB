import { exec } from '../util/exec'
import { log } from '../log'
import type { ProjectTracker, TrackerIssue, TransitionTarget } from './types'

const PRIORITY_RANK: Record<string, number> = {
  Highest: 5,
  High: 4,
  Medium: 3,
  Low: 2,
  Lowest: 1
}

/** Sprint lives in a customfield whose name varies; pull the active one if present. */
function extractSprint(fields: any): string {
  const candidates = [fields.sprint, fields.customfield_10020, fields.customfield_10010]
  for (const c of candidates) {
    if (!c) continue
    const arr = Array.isArray(c) ? c : [c]
    const active =
      arr.find((s: any) => (s?.state ?? '').toLowerCase() === 'active') ?? arr[arr.length - 1]
    if (active) return typeof active === 'string' ? active : (active.name ?? '')
  }
  return ''
}

/** Atlassian Jira adapter via the acli CLI. */
export const jiraTracker: ProjectTracker = {
  id: 'jira',

  async listAssigned(config): Promise<TrackerIssue[]> {
    const jql = config.jql ?? ''
    const r = await exec('acli', ['jira', 'workitem', 'search', '--jql', jql, '--json'], {
      timeoutMs: 30_000
    })
    if (r.code !== 0) throw new Error(`acli search failed: ${r.stderr || r.stdout}`)
    let parsed: any
    try {
      parsed = JSON.parse(r.stdout || '[]')
    } catch {
      log.warn('acli returned non-JSON; returning empty issue list')
      return []
    }
    const items: any[] = Array.isArray(parsed) ? parsed : (parsed.issues ?? parsed.results ?? [])
    return items.map((it) => {
      const fields = it.fields ?? it
      const key = it.key ?? it.issueKey ?? fields.key ?? ''
      const projectKey = fields.project?.key ?? it.project?.key ?? key.split('-')[0] ?? ''
      return {
        key,
        title: fields.summary ?? it.summary ?? '',
        status: fields.status?.name ?? it.status ?? 'To Do',
        assignee: fields.assignee?.displayName ?? it.assignee ?? '',
        priority: PRIORITY_RANK[fields.priority?.name ?? it.priority ?? 'Medium'] ?? 3,
        issueType: fields.issuetype?.name ?? it.issueType ?? it.type ?? 'Story',
        sprint: extractSprint(fields),
        projectKey,
        projectName: fields.project?.name ?? it.project?.name ?? projectKey
      }
    })
  },

  async transition(key: string, target: TransitionTarget): Promise<void> {
    log.info('transitioning jira issue', { key, status: target })
    // The work item MUST go through --key (a positional key errors out), --yes
    // skips the interactive confirm, and --json gives a machine-readable result.
    // acli exits 0 even when the transition fails, so trust the JSON, not the code.
    const r = await exec(
      'acli',
      ['jira', 'workitem', 'transition', '--key', key, '--status', target, '--yes', '--json'],
      { timeoutMs: 20_000 }
    )
    let parsed: { successCount?: number; results?: { status: string; message: string }[] } | null = null
    try {
      parsed = JSON.parse(r.stdout || '{}')
    } catch {
      // Non-JSON output (e.g. a CLI/auth error printed to stdout) → treat as failure.
    }
    if (!parsed || (parsed.successCount ?? 0) < 1) {
      const detail = parsed?.results?.[0]?.message ?? r.stderr ?? r.stdout ?? 'no transition performed'
      throw new Error(`acli transition failed for ${key} -> ${target}: ${detail}`)
    }
  },

  async checkAuth(): Promise<{ ok: boolean; detail: string }> {
    const r = await exec('acli', ['jira', 'auth', 'status'], { timeoutMs: 10_000 })
    return { ok: r.code === 0, detail: (r.stdout || r.stderr).split('\n')[0] ?? '' }
  }
}
