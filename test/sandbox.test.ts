import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import { execFileSync } from 'child_process'
import { buildReviewSandbox, STRIP_ENV_KEYS } from '../src/main/worktree/sandbox'

describe('buildReviewSandbox (security invariant)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskman-sandbox-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('prepends the shim dir to PATH so gh resolves to the shim first', () => {
    const { env, shimDir } = buildReviewSandbox({ worktreePath: dir, realGit: '/usr/bin/git' })
    expect(env.PATH!.split(delimiter)[0]).toBe(shimDir)
    expect(existsSync(join(shimDir, 'gh'))).toBe(true)
    expect(existsSync(join(shimDir, 'git'))).toBe(true)
  })

  it('strips all GitHub auth env vars', () => {
    process.env.GH_TOKEN = 'ghp_secret'
    process.env.GITHUB_TOKEN = 'ghp_secret2'
    const { env } = buildReviewSandbox({ worktreePath: dir, realGit: '/usr/bin/git' })
    for (const key of STRIP_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
  })

  it('the gh shim hard-fails when executed', () => {
    const { shimDir } = buildReviewSandbox({ worktreePath: dir, realGit: '/usr/bin/git' })
    let exitCode = 0
    const cmd = process.platform === 'win32' ? join(shimDir, 'gh.cmd') : join(shimDir, 'gh')
    try {
      execFileSync(cmd, ['pr', 'review', '--approve'], { stdio: 'pipe' })
    } catch (err: any) {
      exitCode = err.status
    }
    expect(exitCode).toBe(87)
  })

  it('the git shim blocks push but the script delegates other commands', () => {
    const { shimDir } = buildReviewSandbox({ worktreePath: dir, realGit: '/usr/bin/git' })
    const filename = process.platform === 'win32' ? 'git.cmd' : 'git'
    const body = readFileSync(join(shimDir, filename), 'utf8')
    expect(body).toContain('push')
    expect(body).toContain('/usr/bin/git')

    let exitCode = 0
    const cmd = process.platform === 'win32' ? join(shimDir, 'git.cmd') : join(shimDir, 'git')
    try {
      execFileSync(cmd, ['push', 'origin', 'main'], { stdio: 'pipe' })
    } catch (err: any) {
      exitCode = err.status
    }
    expect(exitCode).toBe(87)
  })

  it('marks the session env as sandboxed', () => {
    const { env } = buildReviewSandbox({ worktreePath: dir, realGit: '/usr/bin/git' })
    expect(env.AGENT_SANDBOX).toBe('review')
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
  })
})
