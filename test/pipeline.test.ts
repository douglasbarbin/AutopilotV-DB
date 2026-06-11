/**
 * Staged verification pipeline: per-stage recording with checkpoints, gating
 * on the first failure, setup caching, and the secrets cache lifecycle.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  safeStorage: undefined // → secrets store degrades to in-memory in tests
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { runPipeline, clearSecretsCache } from '../src/main/dev/pipeline'
import { __resetSecretsForTesting } from '../src/main/secrets'
import type { TrackerTask, Worktree } from '../src/shared/types/domain'

let dir: string

function seed(runbookYaml: string): { task: TrackerTask; repo: ReturnType<typeof store.getRepo> } {
  const repo = store.upsertRepo({
    name: 'owner/repo',
    remote: 'https://example.com/owner/repo.git',
    defaultBranch: 'main',
    path: dir,
    forge: 'github'
  })
  store.setRepoRunbook(repo.id, '```yaml\n' + runbookYaml + '\n```')
  const { id } = store.upsertTask({
    issueKey: 'PIPE-1',
    title: 'Pipeline test task',
    status: 'in_progress',
    trackerStatus: 'In Progress',
    issueType: 'Story',
    projectKey: 'PIPE',
    assignee: '',
    priority: 3,
    sprint: ''
  })
  store.setTaskRepo(id, repo.id)
  return { task: store.getTask(id)!, repo: store.getRepo(repo.id) }
}

function worktreeStub(): Worktree {
  return {
    id: 1,
    path: dir,
    repoId: 1,
    branch: 'feature',
    kind: 'dev',
    sessionId: null,
    createdAt: '',
    prunedAt: null
  }
}

describe('runPipeline', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    __resetSecretsForTesting()
    dir = mkdtempSync(join(tmpdir(), 'pipeline-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    closeDb()
  })

  it('records per-stage rows and a passing rollup at the draft checkpoint', async () => {
    const { task } = seed(['build:', '  - echo built', 'test:', '  - echo tested'].join('\n'))
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'draft', 'abc123')
    expect(r.ok).toBe(true)
    const rows = store.listVerificationsForTask(task.id)
    expect(rows.find((v) => v.kind === 'build')?.status).toBe('pass')
    expect(rows.find((v) => v.kind === 'test')?.status).toBe('pass')
    const rollup = rows.find((v) => v.kind === 'pipeline')!
    expect(rollup.status).toBe('pass')
    expect(rollup.checkpoint).toBe('draft')
    expect(store.getPipelineVerdict(task.id, 'draft', 'abc123')?.status).toBe('pass')
  })

  it('stops at the first gating failure and reports the failing stage', async () => {
    const { task } = seed(['build:', '  - exit 7', 'test:', '  - echo never'].join('\n'))
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'merge_gate', 'abc')
    expect(r.ok).toBe(false)
    expect(r.failureSummary).toContain('[build]')
    const rows = store.listVerificationsForTask(task.id)
    expect(rows.find((v) => v.kind === 'test')).toBeUndefined() // never ran
    expect(rows.find((v) => v.kind === 'pipeline')?.status).toBe('fail')
  })

  it("the commit checkpoint runs only the test slot", async () => {
    const { task } = seed(['setup:', '  - echo setup', 'test:', '  - echo tested'].join('\n'))
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'commit', 'sha1')
    expect(r.ok).toBe(true)
    expect(r.ranStages).toEqual(['test'])
  })

  it('setup is cached on declared input files and re-runs when they change', async () => {
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: 'pipe' })
    run('git init -q -b main && git config user.email t@t && git config user.name t')
    writeFileSync(join(dir, 'package-lock.json'), 'v1')
    run('git add -A && git commit -qm base')
    const marker = join(dir, 'setup-ran.txt')
    const { task } = seed(
      ['setup:', `  - run: echo ran >> setup-ran.txt`, '    cacheOn: ["package-lock.json"]', 'test:', '  - echo ok'].join('\n')
    )
    const repo = store.getRepo(task.repoId!)!
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's1')
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's2')
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1) // second run cached

    writeFileSync(join(dir, 'package-lock.json'), 'v2') // inputs changed
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's3')
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('secrets: runs once, caches the produced file, then materializes from cache', async () => {
    const { task } = seed(
      [
        'secrets:',
        '  - run: echo SECRET-CONTENT > config.json && echo ran >> secrets-ran.txt',
        '    produces: [config.json]',
        'test:',
        '  - echo ok'
      ].join('\n')
    )
    const repo = store.getRepo(task.repoId!)!
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's1')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toContain('SECRET-CONTENT')

    // Simulate a fresh worktree: the produced file is gone, but the cache serves it
    // without re-running the secrets command.
    unlinkSync(join(dir, 'config.json'))
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's2')
    expect(readFileSync(join(dir, 'config.json'), 'utf8')).toContain('SECRET-CONTENT')
    expect(readFileSync(join(dir, 'secrets-ran.txt'), 'utf8').trim().split('\n')).toHaveLength(1)

    // Refresh secrets → next run executes the command again.
    expect(await clearSecretsCache(repo.id)).toBe(1)
    unlinkSync(join(dir, 'config.json'))
    await runPipeline(task, repo, worktreeStub(), store.getSettings(), 'draft', 's3')
    expect(readFileSync(join(dir, 'secrets-ran.txt'), 'utf8').trim().split('\n')).toHaveLength(2)
  })

  it('secrets failure is an error stage with a hint, and gates the pipeline', async () => {
    const { task } = seed(['secrets:', '  - run: exit 3', '    produces: [config.json]', 'test:', '  - echo ok'].join('\n'))
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'draft', 's1')
    expect(r.ok).toBe(false)
    const row = store.listVerificationsForTask(task.id).find((v) => v.kind === 'secrets')!
    expect(row.status).toBe('error')
    expect(row.summary).toContain('secrets manager unlocked')
  })

  it('an empty runbook is a no-op (legacy path handles verification)', async () => {
    const { task } = seed('version: 1')
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'draft', 's1')
    expect(r.ok).toBe(true)
    expect(r.ranStages).toEqual([])
  })

  it('e2e advisory failures are recorded but never gate', async () => {
    // app with no ready probe: the process must just survive the grace period.
    const { task } = seed(
      [
        'test:',
        '  - echo ok',
        'app:',
        '  run: sleep 30',
        'e2e:',
        '  - run: exit 5',
        '    gate: advisory'
      ].join('\n')
    )
    const r = await runPipeline(task, store.getRepo(task.repoId!)!, worktreeStub(), store.getSettings(), 'draft', 's1')
    expect(r.ok).toBe(true)
    const rows = store.listVerificationsForTask(task.id)
    expect(rows.find((v) => v.kind === 'app')?.status).toBe('pass')
    expect(rows.find((v) => v.kind === 'e2e')?.status).toBe('fail')
    expect(rows.find((v) => v.kind === 'pipeline')?.status).toBe('pass')
  }, 20_000)
})
