import { vi, describe, it, expect, beforeEach } from 'vitest'

const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('../src/main/util/exec', () => ({ exec: execMock, execOrThrow: vi.fn() }))

import { jiraTracker } from '../src/main/trackers/jira'

describe('jiraTracker.transition', () => {
  beforeEach(() => execMock.mockReset())

  it('passes the key via --key with --yes and --json (not a positional)', async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({ successCount: 1, results: [{ status: 'SUCCESS', message: 'ok', id: 'X-1' }] }),
      stderr: '',
      code: 0
    })
    await jiraTracker.transition('X-1', 'In Progress', {})
    const [, args] = execMock.mock.calls[0]
    expect(args).toEqual(['jira', 'workitem', 'transition', '--key', 'X-1', '--status', 'In Progress', '--yes', '--json'])
    // The bug was passing the key positionally — guard against a regression.
    expect(args.indexOf('--key')).toBe(args.indexOf('X-1') - 1)
  })

  it('throws on a failed transition even though acli exits 0', async () => {
    // acli returns code 0 with a FAILURE result — the old code (code !== 0) missed this.
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        successCount: 0,
        results: [{ status: 'FAILURE', message: 'No allowed transitions found for given status', id: 'X-1' }]
      }),
      stderr: '',
      code: 0
    })
    await expect(jiraTracker.transition('X-1', 'In Review', {})).rejects.toThrow(/No allowed transitions/)
  })

  it('throws when acli emits non-JSON (e.g. a CLI/auth error on stdout)', async () => {
    execMock.mockResolvedValue({ stdout: '✗ Error: not authenticated', stderr: '', code: 0 })
    await expect(jiraTracker.transition('X-1', 'In Progress', {})).rejects.toThrow(/transition failed/)
  })
})

describe('jiraTracker.createIssue', () => {
  beforeEach(() => execMock.mockReset())

  const draft = {
    projectKey: 'LDWF',
    title: 'Add tests for parser',
    description: 'From AutopilotV analysis',
    kind: 'test_gap',
    priority: 'medium' as const
  }

  it('creates a Task and parses the key from JSON output', async () => {
    execMock.mockResolvedValue({ stdout: JSON.stringify({ key: 'LDWF-99' }), stderr: '', code: 0 })
    const created = await jiraTracker.createIssue!(draft, {})
    expect(created.key).toBe('LDWF-99')
    const [, args] = execMock.mock.calls[0]
    expect(args.slice(0, 3)).toEqual(['jira', 'workitem', 'create'])
    expect(args).toContain('--project')
    expect(args[args.indexOf('--type') + 1]).toBe('Task')
  })

  it('maps bug follow-ups to the Bug issue type', async () => {
    execMock.mockResolvedValue({ stdout: JSON.stringify({ key: 'LDWF-100' }), stderr: '', code: 0 })
    await jiraTracker.createIssue!({ ...draft, kind: 'bug' }, {})
    const [, args] = execMock.mock.calls[0]
    expect(args[args.indexOf('--type') + 1]).toBe('Bug')
  })

  it('salvages the key by regex when acli output is not clean JSON', async () => {
    execMock.mockResolvedValue({ stdout: '✓ Created work item LDWF-101', stderr: '', code: 0 })
    const created = await jiraTracker.createIssue!(draft, {})
    expect(created.key).toBe('LDWF-101')
  })

  it('throws when no key can be found', async () => {
    execMock.mockResolvedValue({ stdout: 'something went sideways', stderr: '', code: 0 })
    await expect(jiraTracker.createIssue!(draft, {})).rejects.toThrow(/no issue key/)
  })
})
