import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { injectAgentsTemplate } from '../src/main/worktree/manager'

const TEMPLATE = '## Standards\n- be excellent'

describe('injectAgentsTemplate', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'autopilotv-agents-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates AGENTS.md with the injected block when none exists', async () => {
    await injectAgentsTemplate(dir, TEMPLATE)
    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('AUTOPILOTV:BEGIN')
    expect(out).toContain('be excellent')
    expect(out).toContain('AUTOPILOTV:END')
  })

  it('appends below existing content and is idempotent', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nExisting line.\n')
    await injectAgentsTemplate(dir, TEMPLATE)
    await injectAgentsTemplate(dir, TEMPLATE) // second time should replace, not duplicate
    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('# Project rules')
    expect(out).toContain('Existing line.')
    expect(out.match(/AUTOPILOTV:BEGIN/g)?.length).toBe(1)
    expect(out.indexOf('Existing line.')).toBeLessThan(out.indexOf('AUTOPILOTV:BEGIN'))
  })

  it('replaces a block injected under a previous product name', async () => {
    writeFileSync(
      join(dir, 'AGENTS.md'),
      '# Rules\n\n<!-- OLDNAME:BEGIN injected coding standards (not committed) -->\nstale standards\n<!-- OLDNAME:END -->\n'
    )
    await injectAgentsTemplate(dir, TEMPLATE)
    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('# Rules')
    expect(out).not.toContain('OLDNAME')
    expect(out).not.toContain('stale standards')
    expect(out.match(/AUTOPILOTV:BEGIN/g)?.length).toBe(1)
  })

  it('does nothing when the template is empty', async () => {
    await injectAgentsTemplate(dir, '   ')
    expect(existsSync(join(dir, 'AGENTS.md'))).toBe(false)
  })

  it('excludes a newly created AGENTS.md from git', async () => {
    await injectAgentsTemplate(dir, TEMPLATE)
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()
    expect(status).not.toContain('AGENTS.md')
  })

  it('appends to a COMMITTED AGENTS.md under skip-worktree, keeping the tree clean', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    writeFileSync(join(dir, 'AGENTS.md'), '# Repo-owned rules\n')
    git('add', 'AGENTS.md')
    git('commit', '-qm', 'add agents')

    await injectAgentsTemplate(dir, TEMPLATE)

    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('# Repo-owned rules')
    expect(out).toContain('be excellent') // harness auto-read sees the standards
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()
    expect(status.trim()).toBe('') // skip-worktree hides the modification
  })

  it('the unblock recipe we give agents actually completes a blocked merge', async () => {
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir })
    git('config', 'user.email', 't@t')
    git('config', 'user.name', 't')
    git('checkout', '-qb', 'main')
    writeFileSync(join(dir, 'AGENTS.md'), '# Repo-owned rules v1\n')
    git('add', 'AGENTS.md')
    git('commit', '-qm', 'v1')
    writeFileSync(join(dir, 'AGENTS.md'), '# Repo-owned rules v2\n')
    git('commit', '-qam', 'v2')
    // Feature branch from BEFORE main's AGENTS.md change, then inject.
    git('checkout', '-qb', 'feature', 'HEAD~1')
    await injectAgentsTemplate(dir, TEMPLATE)

    // The known git invariant: the skip-worktree'd local change blocks the merge.
    expect(() => git('merge', 'main')).toThrow()

    // AGENTS_MERGE_UNBLOCK recipe, exactly as prompted:
    const saved = readFileSync(join(dir, 'AGENTS.md'), 'utf8') // 1. save
    git('update-index', '--no-skip-worktree', 'AGENTS.md') // 2. unprotect
    git('checkout', '--', 'AGENTS.md')
    git('merge', 'main') // 3. merge completes
    const block = saved.slice(saved.indexOf('<!-- AUTOPILOTV:BEGIN')) // 4. reapply
    writeFileSync(join(dir, 'AGENTS.md'), readFileSync(join(dir, 'AGENTS.md'), 'utf8') + '\n' + block)
    git('update-index', '--skip-worktree', 'AGENTS.md')

    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('v2') // merged content
    expect(out).toContain('be excellent') // injected block reapplied
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: dir }).toString()
    expect(status.trim()).toBe('') // re-protected
  })
})
