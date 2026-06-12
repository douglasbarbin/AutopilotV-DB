import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, delimiter } from 'path'
import { execFileSync } from 'child_process'
import {
  buildReviewSandbox,
  GITHUB_STRIP_ENV_KEYS,
  AZURE_DEVOPS_STRIP_ENV_KEYS
} from '../src/main/worktree/sandbox'

describe('buildReviewSandbox (security invariant)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopilotv-sandbox-'))
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
    for (const key of GITHUB_STRIP_ENV_KEYS) {
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
      execFileSync(cmd, ['pr', 'review', '--approve'], { stdio: 'pipe', shell: true })
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
      execFileSync(cmd, ['push', 'origin', 'main'], { stdio: 'pipe', shell: true })
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

  it('azure devops forge: blocks the az cli and strips Azure DevOps auth env', () => {
    process.env.AZURE_DEVOPS_PAT = 'secret'
    process.env.AZURE_DEVOPS_EXT_PAT = 'secret2'
    process.env.AZURE_DEVOPS_ORG = 'myorg'
    const { env, shimDir } = buildReviewSandbox({
      worktreePath: dir,
      realGit: '/usr/bin/git',
      forge: 'azuredevops'
    })
    expect(existsSync(join(shimDir, 'az'))).toBe(true)
    // Should NOT have github-only shims or strip keys
    expect(existsSync(join(shimDir, 'gh'))).toBe(false)
    for (const key of AZURE_DEVOPS_STRIP_ENV_KEYS) {
      expect(env[key]).toBeUndefined()
    }
    for (const key of GITHUB_STRIP_ENV_KEYS) {
      if (key === 'GIT_ASKPASS' || key === 'SSH_AUTH_SOCK') continue
      // The ADO strip list doesn't include GH_TOKEN etc., so they should remain
      // (though in practice ADO and GH are different processes).
      expect(env[key]).toBe(process.env[key])
    }
    delete process.env.AZURE_DEVOPS_PAT
    delete process.env.AZURE_DEVOPS_EXT_PAT
    delete process.env.AZURE_DEVOPS_ORG
  })

  it('the az shim hard-fails when executed', () => {
    const { shimDir } = buildReviewSandbox({
      worktreePath: dir,
      realGit: '/usr/bin/git',
      forge: 'azuredevops'
    })
    let exitCode = 0
    const cmd = process.platform === 'win32' ? join(shimDir, 'az.cmd') : join(shimDir, 'az')
    try {
      execFileSync(cmd, ['repos', 'pr', 'review', '--approve'], { stdio: 'pipe', shell: true })
    } catch (err: any) {
      exitCode = err.status
    }
    expect(exitCode).toBe(87)
  })
})

