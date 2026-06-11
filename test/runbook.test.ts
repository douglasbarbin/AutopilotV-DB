/**
 * Runbook: schema/parse tolerance, resolution order (override → repo file →
 * legacy verify command), and substitution variables.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseRunbookDoc,
  resolveRunbook,
  substituteVars,
  isEmptyRunbook,
  RUNBOOK_FILENAME
} from '../src/main/runbook/runbook'
import type { Repo } from '../src/shared/types/domain'

const DOC = `# Runbook

Narrative for agents.

\`\`\`yaml
version: 1
setup:
  - run: npm ci
    cacheOn: ["package-lock.json"]
secrets:
  - run: op inject -i t.json -o config.json
    produces: [config.json]
test:
  - npm test
app:
  run: npm start
  ports: { web: auto }
  ready: { url: "http://localhost:{port:web}/health" }
e2e:
  - run: npx cypress run --config baseUrl=http://localhost:{port:web}
    artifacts: [cypress/screenshots]
    gate: blocking
\`\`\`
`

function repoStub(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 1,
    name: 'owner/repo',
    path: null,
    remote: '',
    defaultBranch: 'main',
    cloneState: 'present',
    forge: 'github',
    verifyCommand: null,
    runbook: null,
    ...overrides
  }
}

describe('parseRunbookDoc', () => {
  it('parses the yaml block: coerced string steps, defaults applied', () => {
    const { runbook, error } = parseRunbookDoc(DOC)
    expect(error).toBeUndefined()
    expect(runbook!.setup[0]).toMatchObject({ run: 'npm ci', cacheOn: ['package-lock.json'] })
    expect(runbook!.test[0].run).toBe('npm test') // bare string coerced
    expect(runbook!.secrets[0]).toMatchObject({ produces: ['config.json'], cacheTtlHours: 12 })
    expect(runbook!.app!.ports.web).toBe('auto')
    expect(runbook!.e2e[0].gate).toBe('blocking')
  })

  it('a document without a yaml block is narrative-only (no steps, no error)', () => {
    const { runbook, error } = parseRunbookDoc('# Just notes\nDo things carefully.')
    expect(runbook).toBeNull()
    expect(error).toBeUndefined()
  })

  it('malformed yaml reports the error without throwing', () => {
    const { runbook, error } = parseRunbookDoc('```yaml\nsetup: [unclosed\n```')
    expect(runbook).toBeNull()
    expect(error).toBeTruthy()
  })
})

describe('resolveRunbook', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'runbook-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('operator override wins over the repo file', () => {
    writeFileSync(join(dir, RUNBOOK_FILENAME), DOC)
    const r = resolveRunbook(repoStub({ path: dir, runbook: '```yaml\ntest:\n  - echo override\n```' }))
    expect(r.source).toBe('override')
    expect(r.runbook.test[0].run).toBe('echo override')
  })

  it('falls back to the RUNBOOK.md committed in the trunk clone', () => {
    writeFileSync(join(dir, RUNBOOK_FILENAME), DOC)
    const r = resolveRunbook(repoStub({ path: dir }))
    expect(r.source).toBe('repo')
    expect(r.runbook.app?.run).toBe('npm start')
    expect(r.narrative).toContain('Narrative for agents')
  })

  it('falls back to the legacy verify command as a single test step', () => {
    const r = resolveRunbook(repoStub({ verifyCommand: 'make check' }))
    expect(r.source).toBe('legacy')
    expect(r.runbook.test).toEqual([{ run: 'make check', cacheOn: [] }])
  })

  it('resolves to an empty runbook when nothing is configured', () => {
    const r = resolveRunbook(repoStub())
    expect(r.source).toBe('none')
    expect(isEmptyRunbook(r.runbook)).toBe(true)
  })

  it('a narrative-only override keeps the legacy steps but the override narrative', () => {
    const r = resolveRunbook(repoStub({ verifyCommand: 'make check', runbook: '# How this app works\nNotes.' }))
    expect(r.source).toBe('override')
    expect(r.runbook.test[0].run).toBe('make check')
    expect(r.narrative).toContain('How this app works')
  })
})

describe('substituteVars', () => {
  it('substitutes ports, instance, and worktree; leaves unknown placeholders', () => {
    const out = substituteVars('start --url http://x:{port:web} -p {instance} -d {worktree} {port:db} {nope}', {
      ports: { web: 4321, db: 5555 },
      instance: 'autopilotv-1-2',
      worktree: '/tmp/wt'
    })
    expect(out).toBe('start --url http://x:4321 -p autopilotv-1-2 -d /tmp/wt 5555 {nope}')
  })
})
