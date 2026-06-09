/**
 * Independent verification gate (theme B): the auto-detect heuristic, the
 * command verification verdict, and the verified_sha short-circuit that keeps
 * the gate from re-running the suite every tick on an unchanged commit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { detectVerifyCommand, verifyTaskForMerge } from '../src/main/dev/verify'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

function makeRepoWithCommit(): string {
  const dir = mkdtempSync(join(tmpdir(), 'apv-verify-'))
  git(dir, 'init', '-q')
  git(dir, 'config', 'user.email', 't@t.test')
  git(dir, 'config', 'user.name', 'Test')
  writeFileSync(join(dir, 'a.txt'), 'one')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'first')
  return dir
}

describe('detectVerifyCommand', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apv-detect-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('returns null when there is no package.json', () => {
    expect(detectVerifyCommand(dir)).toBeNull()
  })
  it('prefers a real test script', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest', build: 'tsc' } }))
    expect(detectVerifyCommand(dir)).toBe('npm test')
  })
  it('skips the npm placeholder test script and falls back to build', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1', build: 'tsc' } })
    )
    expect(detectVerifyCommand(dir)).toBe('npm run build')
  })
  it('returns null when no usable script exists', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'eslint .' } }))
    expect(detectVerifyCommand(dir)).toBeNull()
  })
})

describe('verifyTaskForMerge', () => {
  let repoDir: string

  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    store.updateSettings({ verifySpecConformance: false })
    repoDir = makeRepoWithCommit()
  })
  afterEach(() => {
    closeDb()
    rmSync(repoDir, { recursive: true, force: true })
  })

  function seed(verifyCommand: string): { taskId: number } {
    const repo = store.upsertRepo({
      name: 'owner/repo',
      remote: 'https://example.com/owner/repo.git',
      defaultBranch: 'main',
      path: repoDir,
      forge: 'github'
    })
    store.setRepoVerifyCommand(repo.id, verifyCommand)
    const wt = store.createWorktree({ path: repoDir, repoId: repo.id, branch: 'feature', kind: 'dev', sessionId: null })
    const { id: taskId } = store.upsertTask({ issueKey: 'T-1', title: 'task', projectKey: 'T' })
    store.setTaskRepo(taskId, repo.id)
    store.setTaskWorktree(taskId, wt)
    store.setTaskPr(taskId, 7, 'https://example.com/pr/7')
    return { taskId }
  }

  it('passes and records a pass verification when the command exits 0', async () => {
    const { taskId } = seed('exit 0')
    const r = await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    expect(r.ok).toBe(true)
    const v = store.listVerificationsForTask(taskId).find((x) => x.kind === 'command')
    expect(v?.status).toBe('pass')
    expect(store.getTask(taskId)!.verifiedSha).not.toBe('')
  })

  it('fails (blocks) and records a fail when the command exits non-zero', async () => {
    const { taskId } = seed('exit 1')
    const r = await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    expect(r.ok).toBe(false)
    expect(r.failureSummary).toBeTruthy()
    const v = store.listVerificationsForTask(taskId).find((x) => x.kind === 'command')
    expect(v?.status).toBe('fail')
  })

  it('does not re-run on an unchanged commit (verified_sha short-circuit)', async () => {
    const { taskId } = seed('exit 1')
    await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    const after1 = store.listVerificationsForTask(taskId).length
    const r2 = await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    const after2 = store.listVerificationsForTask(taskId).length
    expect(r2.ok).toBe(false) // cached fail verdict
    expect(after2).toBe(after1) // no new verification row
  })

  it('skips (does not block) when no verify command is configured or detected', async () => {
    const { taskId } = seed('')
    const r = await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    expect(r.ok).toBe(true)
    const v = store.listVerificationsForTask(taskId).find((x) => x.kind === 'command')
    expect(v?.status).toBe('skipped')
  })

  it('re-verifies after a new commit (changed SHA)', async () => {
    const { taskId } = seed('exit 1')
    await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    const before = store.listVerificationsForTask(taskId).length
    // New commit → new SHA.
    writeFileSync(join(repoDir, 'a.txt'), 'two')
    git(repoDir, 'add', '-A')
    git(repoDir, 'commit', '-qm', 'second')
    await verifyTaskForMerge(store.getTask(taskId)!, store.getSettings())
    expect(store.listVerificationsForTask(taskId).length).toBeGreaterThan(before)
  })
})
