import { exec } from '../util/exec'
import { log } from '../log'
import type { IssueDraft, ProjectTracker, TrackerIssue, TransitionTarget } from './types'

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
  capabilities: { createIssue: true },

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
  },

  async createIssue(draft: IssueDraft): Promise<{ key: string; url?: string }> {
    const create = (type: string) =>
      exec(
        'acli',
        [
          'jira',
          'workitem',
          'create',
          '--project',
          draft.projectKey,
          '--type',
          type,
          '--summary',
          draft.title,
          '--description',
          draft.description || draft.title,
          '--json'
        ],
        { timeoutMs: 30_000 }
      )

    const preferred = draft.kind === 'bug' ? 'Bug' : 'Task'
    log.info('creating jira issue', { project: draft.projectKey, type: preferred })
    let r = await create(preferred)

    // Issue types are per-project (e.g. a project with Story but no Task).
    // Jira's rejection lists what IS allowed — parse it and retry once with
    // the best fit rather than failing the human's click.
    if (r.code !== 0) {
      const allowed = parseAllowedTypes(`${r.stderr}\n${r.stdout}`)
      const fallback = pickIssueType(draft.kind, allowed, preferred)
      if (fallback) {
        log.info('retrying jira create with project-allowed type', { project: draft.projectKey, type: fallback })
        r = await create(fallback)
      }
    }
    if (r.code !== 0) throw new Error(`acli create failed: ${(r.stderr || r.stdout).slice(0, 200)}`)
    // acli output shapes vary by version; pull the key defensively.
    let key = ''
    let url: string | undefined
    try {
      const parsed = JSON.parse(r.stdout || '{}')
      const item = Array.isArray(parsed) ? parsed[0] : (parsed.results?.[0] ?? parsed)
      key = item?.key ?? item?.issueKey ?? ''
      url = item?.url ?? item?.link ?? undefined
    } catch {
      /* fall through to the regex */
    }
    if (!key) key = r.stdout.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] ?? ''
    if (!key) throw new Error(`acli create returned no issue key: ${r.stdout.slice(0, 200)}`)
    return { key, url }
  }
}

/** Pull the allowed-type list out of Jira's "Please provide valid issue type"
 *  rejection. Returns [] when the error is something else. */
export function parseAllowedTypes(text: string): string[] {
  const m = text.match(/allowed issue types[^:]*:\s*([^\n]+)/i)
  if (!m) return []
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/[.\s]+$/, ''))
    .filter(Boolean)
}

/** Best project-allowed type for a follow-up kind: Bug for bugs when offered,
 *  then Story, then Task; never auto-pick container/child types. */
export function pickIssueType(kind: string, allowed: string[], exclude: string): string | null {
  const find = (name: string) =>
    allowed.find((a) => a.toLowerCase() === name.toLowerCase() && a.toLowerCase() !== exclude.toLowerCase())
  if (kind === 'bug') {
    const bug = find('Bug')
    if (bug) return bug
  }
  for (const candidate of ['Story', 'Task']) {
    const got = find(candidate)
    if (got) return got
  }
  const avoid = new Set(['epic', 'sub-task', 'subtask', 'initiative', exclude.toLowerCase()])
  return allowed.find((a) => !avoid.has(a.toLowerCase())) ?? null
}
