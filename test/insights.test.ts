/**
 * Post-implementation insights: the followups/knowledge store, signal-report
 * harvesting, knowledge selection for AGENTS.md injection, and the
 * deterministic TODO scan of a merged task's diff.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { harvestSignalReport, scanDiffForTodos } from '../src/main/analysis/engine'
import { buildAgentsContent } from '../src/main/worktree/manager'
import type { TrackerTask } from '../src/shared/types/domain'

function seedTask(): TrackerTask {
  const { id } = store.upsertTask({
    issueKey: 'TEST-9',
    title: 'Test task',
    status: 'todo',
    trackerStatus: 'To Do',
    issueType: 'Story',
    projectKey: 'TEST'
  })
  const repo = store.upsertRepo({
    name: 'owner/repo',
    remote: 'https://example.com/owner/repo.git',
    defaultBranch: 'main',
    path: null,
    forge: 'github'
  })
  store.setTaskRepo(id, repo.id)
  return store.getTask(id)!
}

describe('insights store', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
  })
  afterEach(() => closeDb())

  it('deduplicates follow-ups by content hash', () => {
    const task = seedTask()
    const first = store.insertFollowUp({
      taskId: task.id,
      repoId: task.repoId,
      title: 'Add tests for the parser',
      kind: 'test_gap'
    })
    const dup = store.insertFollowUp({
      taskId: task.id,
      repoId: task.repoId,
      title: '  add Tests   for the parser ', // same content, different whitespace/case
      kind: 'test_gap'
    })
    expect(first).not.toBeNull()
    expect(dup).toBeNull()
    expect(store.listFollowUps()).toHaveLength(1)
  })

  it('follow-up lifecycle: candidate → created with issue key', () => {
    const task = seedTask()
    const id = store.insertFollowUp({ taskId: task.id, repoId: task.repoId, title: 'Fix flaky test' })!
    store.setFollowUpStatus(id, 'created', 'TEST-42')
    const f = store.getFollowUp(id)!
    expect(f.status).toBe('created')
    expect(f.createdIssueKey).toBe('TEST-42')
  })

  it('harvestSignalReport stores follow-ups and learnings from an agent report', () => {
    const task = seedTask()
    const res = harvestSignalReport(task, {
      version: 1,
      summary: 'did things',
      deviations: '',
      followUps: [
        { title: 'Wire pagination', description: 'list endpoint', kind: 'enhancement', priority: 'medium', files: [] }
      ],
      learnings: [
        { role: 'coding', insight: 'Repo uses pnpm, not npm', evidence: 'package.json', confidence: 'high' }
      ]
    })
    expect(res).toEqual({ followUps: 1, learnings: 1 })
    expect(store.listFollowUps('candidate')).toHaveLength(1)
    expect(store.listKnowledge('candidate')).toHaveLength(1)
  })

  it('selects only ACTIVE knowledge for the right repo and role, and tracks usage', () => {
    const task = seedTask()
    const repoId = task.repoId!
    const a = store.insertKnowledge({ repoId, role: 'coding', insight: 'Use pnpm', confidence: 'high' })!
    store.insertKnowledge({ repoId, role: 'coding', insight: 'Still a candidate' })
    const g = store.insertKnowledge({ scope: 'global', role: 'coding', insight: 'Global active insight' })!
    const r = store.insertKnowledge({ repoId, role: 'review', insight: 'Review-only insight' })!
    store.setKnowledgeStatus(a, 'active')
    store.setKnowledgeStatus(g, 'active')
    store.setKnowledgeStatus(r, 'active')

    const picked = store.selectKnowledgeForInjection(repoId, 'coding')
    expect(picked.map((k) => k.insight).sort()).toEqual(['Global active insight', 'Use pnpm'])

    store.markKnowledgeApplied(picked.map((k) => k.id))
    const after = store.listKnowledge().find((k) => k.id === a)!
    expect(after.hitCount).toBe(1)
    expect(after.lastAppliedAt).toBeTruthy()
  })

  it('buildAgentsContent appends a learned-conventions section only when active knowledge exists', () => {
    const task = seedTask()
    const repoId = task.repoId!
    store.updateSettings({ agentsTemplate: '## Standards\n- be nice' })

    expect(buildAgentsContent(repoId, 'coding')).toBe('## Standards\n- be nice')

    const id = store.insertKnowledge({ repoId, role: 'coding', insight: 'Run make gen after schema edits' })!
    store.setKnowledgeStatus(id, 'active')
    const content = buildAgentsContent(repoId, 'coding')
    expect(content).toContain('Learned conventions')
    expect(content).toContain('Run make gen after schema edits')
  })
})

describe('scanDiffForTodos', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopilotv-todo-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('finds TODO/FIXME lines added relative to the base branch', async () => {
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' })
    run('git init -q -b main')
    run('git config user.email t@t && git config user.name t')
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n')
    run('git add -A && git commit -qm base')
    // Simulate the remote base branch ref the scan diffs against.
    mkdirSync(join(dir, '.git/refs/remotes/origin'), { recursive: true })
    run('git update-ref refs/remotes/origin/main HEAD')
    run('git checkout -qb feature')
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1\n// TODO: handle the zero case\n')
    run('git add -A && git commit -qm feat')

    const todos = await scanDiffForTodos(dir, 'main')
    expect(todos).toHaveLength(1)
    expect(todos[0].file).toBe('a.ts')
    expect(todos[0].line).toContain('TODO: handle the zero case')
  })
})
