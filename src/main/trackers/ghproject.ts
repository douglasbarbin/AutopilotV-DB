import { exec } from '../util/exec'
import { log } from '../log'
import type { ProjectTracker, TrackerIssue, TransitionTarget } from './types'

function repoNwo(repository: unknown): string {
  const s = String(repository ?? '')
  if (!s) return ''
  if (s.includes('github.com/')) {
    const parts = s.split('github.com/')[1]?.split('/') ?? []
    return parts.slice(0, 2).join('/')
  }
  return s // already owner/repo
}

function isDoneStatus(s: string): boolean {
  return /done|closed|complete|cancel|ship|merged/i.test(s)
}

const PRIORITY_WORDS: Record<string, number> = {
  urgent: 5,
  highest: 5,
  high: 4,
  p0: 5,
  p1: 4,
  medium: 3,
  normal: 3,
  p2: 3,
  low: 2,
  p3: 2,
  lowest: 1
}

/**
 * GitHub Projects (v2) adapter via the `gh project` CLI.
 *
 * Config: owner (user/org), projectNumber, optional username (filter to items
 * assigned to that login), optional statusField (default "Status").
 *
 * Status is a custom single-select field managed on the board; AutopilotV reads it
 * but does not move cards (transition is a logged no-op) — manage status on the
 * project board, or wire transitions to `gh project item-edit` if desired.
 */
export const ghProjectTracker: ProjectTracker = {
  id: 'ghproject',

  async listAssigned(config): Promise<TrackerIssue[]> {
    const owner = config.owner ?? ''
    const number = config.projectNumber ?? ''
    if (!owner || !number) return []
    const r = await exec('gh', [
      'project',
      'item-list',
      number,
      '--owner',
      owner,
      '--format',
      'json',
      '-L',
      '300'
    ])
    if (r.code !== 0) throw new Error(`gh project item-list failed: ${r.stderr || r.stdout}`)
    const parsed = JSON.parse(r.stdout || '{}')
    const items: any[] = Array.isArray(parsed) ? parsed : (parsed.items ?? [])
    const statusKey = (config.statusField ?? 'status').toLowerCase()
    const me = (config.username ?? '').toLowerCase()

    const out: TrackerIssue[] = []
    for (const it of items) {
      const content = it.content ?? {}
      const itemNumber = content.number
      if (itemNumber == null) continue // skip draft items without an issue/PR
      const nwo = repoNwo(content.repository)
      const repoShort = nwo.split('/').pop() ?? 'repo'
      const status = String(it[statusKey] ?? it.status ?? it.Status ?? '')
      if (isDoneStatus(status)) continue
      const assignees: string[] = (content.assignees ?? it.assignees ?? []).map((a: any) =>
        String(a?.login ?? a).toLowerCase()
      )
      if (me && assignees.length && !assignees.includes(me)) continue
      const priRaw = String(it.priority ?? it.Priority ?? '').toLowerCase()
      out.push({
        key: `${repoShort}-${itemNumber}`,
        title: content.title ?? it.title ?? '',
        status: status || 'To Do',
        assignee: (content.assignees?.[0]?.login ?? content.assignees?.[0] ?? '') as string,
        priority: PRIORITY_WORDS[priRaw] ?? 3,
        issueType: content.type === 'PullRequest' ? 'PR' : (it.type ?? it.Type ?? 'Issue'),
        sprint: String(it.iteration ?? it.sprint ?? it.Iteration ?? ''),
        projectKey: repoShort,
        projectName: nwo || repoShort
      })
    }
    return out
  },

  async transition(key: string, target: TransitionTarget): Promise<void> {
    // Status is a board-managed single-select field; we don't move cards here.
    log.info('gh-projects transition skipped (manage status on the board)', { key, target })
  },

  async checkAuth(config): Promise<{ ok: boolean; detail: string }> {
    const owner = config.owner ?? ''
    const number = config.projectNumber ?? ''
    if (!owner || !number) return { ok: false, detail: 'set owner + project number' }
    const r = await exec(
      'gh',
      ['project', 'item-list', number, '--owner', owner, '--format', 'json', '-L', '1'],
      { timeoutMs: 12_000 }
    )
    return { ok: r.code === 0, detail: r.code === 0 ? `${owner}/#${number}` : (r.stderr || r.stdout).split('\n')[0] }
  }
}
