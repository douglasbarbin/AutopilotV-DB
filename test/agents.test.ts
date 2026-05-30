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
    dir = mkdtempSync(join(tmpdir(), 'taskman-agents-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('creates AGENTS.md with the injected block when none exists', async () => {
    await injectAgentsTemplate(dir, TEMPLATE)
    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('TASKMAN:BEGIN')
    expect(out).toContain('be excellent')
    expect(out).toContain('TASKMAN:END')
  })

  it('appends below existing content and is idempotent', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# Project rules\nExisting line.\n')
    await injectAgentsTemplate(dir, TEMPLATE)
    await injectAgentsTemplate(dir, TEMPLATE) // second time should replace, not duplicate
    const out = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(out).toContain('# Project rules')
    expect(out).toContain('Existing line.')
    expect(out.match(/TASKMAN:BEGIN/g)?.length).toBe(1)
    expect(out.indexOf('Existing line.')).toBeLessThan(out.indexOf('TASKMAN:BEGIN'))
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
})
