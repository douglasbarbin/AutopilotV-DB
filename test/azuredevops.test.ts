import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock the env logger so test output stays clean.
vi.mock('../src/main/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Replace the `fetch` global with a hoisted spy so we can assert on requests
// without touching the real network.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.stubGlobal('fetch', fetchMock)

import { azureDevOpsTracker } from '../src/main/trackers/azuredevops'

interface FakeResp {
  ok: boolean
  status: number
  text?: () => Promise<string>
  json?: () => Promise<any>
}

function jsonResp(body: any, status = 200): FakeResp {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}
function emptyResp(status = 204): FakeResp {
  return { ok: status >= 200 && status < 300, status, json: async () => null }
}
function errorResp(status: number, text = 'oops'): FakeResp {
  return { ok: false, status, text: async () => text }
}

const CONFIG = { org: 'myorg', project: 'MyProject', pat: 'pat123', assigneeFilter: '' }

describe('azureDevOpsTracker.listAssigned', () => {
  beforeEach(() => fetchMock.mockReset())

  it('returns [] when org or pat is missing (no network call)', async () => {
    const items = await azureDevOpsTracker.listAssigned({ org: '', pat: 'x' })
    expect(items).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('runs a WIQL query and maps work items from the detail endpoint', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResp({ workItems: [{ id: 42 }, { id: 7 }] })
      )
      .mockResolvedValueOnce(
        jsonResp({
          value: [
            {
              id: 42,
              fields: {
                'System.Title': 'Fix widget',
                'System.State': 'Active',
                'System.WorkItemType': 'Task',
                'System.Priority': 1,
                'System.AssignedTo': { displayName: 'Jane Dev', uniqueName: 'jane@x.com' },
                'System.IterationPath': 'MyProject\\Sprint 12',
                'System.TeamProject': 'MyProject'
              }
            },
            {
              id: 7,
              fields: {
                'System.Title': 'Old work',
                'System.State': 'Closed',
                'System.WorkItemType': 'Bug',
                'System.Priority': 3
              }
            }
          ]
        })
      )

    const items = await azureDevOpsTracker.listAssigned(CONFIG)
    expect(items).toHaveLength(1) // Closed item filtered out
    const it = items[0]
    expect(it).toMatchObject({
      key: '42',
      title: 'Fix widget',
      status: 'In Progress',
      assignee: 'Jane Dev',
      issueType: 'Task',
      sprint: 'MyProject\\Sprint 12',
      projectKey: 'MyProject',
      projectName: 'MyProject'
    })
    // Azure DevOps priority 1 (highest) → AutopilotV priority 5.
    expect(it.priority).toBe(5)

    // Verify the WIQL call: Basic auth, project-scoped URL, and @Me when no
    // assignee filter is set.
    const [wiqlUrl, wiqlInit] = fetchMock.mock.calls[0]
    expect(wiqlUrl).toBe('https://dev.azure.com/myorg/MyProject/_apis/wit/wiql?api-version=7.1-preview.2')
    expect(wiqlInit.method).toBe('POST')
    expect(wiqlInit.headers.Authorization).toBe('Basic ' + Buffer.from(':pat123').toString('base64'))
    const body = JSON.parse(wiqlInit.body)
    expect(body.query).toMatch(/\[System\.AssignedTo\] = @Me/)
    expect(body.query).toMatch(/\[System\.WorkItemType\] <> 'Epic'/)
    expect(body.query).toMatch(/ORDER BY/)

    // Detail call uses the comma-joined ids.
    const [detailUrl] = fetchMock.mock.calls[1]
    expect(detailUrl).toContain('workitems?ids=42,7')
  })

  it('honors an explicit assignee filter and routes WIQL under the org root when no project is set', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ workItems: [] })) // no ids → no detail call
    const items = await azureDevOpsTracker.listAssigned({
      org: 'o',
      project: '',
      pat: 'p',
      assigneeFilter: 'alex@example.com'
    })
    expect(items).toEqual([])

    const [wiqlUrl, init] = fetchMock.mock.calls[0]
    expect(wiqlUrl).toBe('https://dev.azure.com/o/_apis/wit/wiql?api-version=7.1-preview.2')
    const body = JSON.parse(init.body)
    expect(body.query).toContain("'alex@example.com'")
    expect(body.query).not.toContain('@Me')
  })
})

describe('azureDevOpsTracker.transition', () => {
  beforeEach(() => fetchMock.mockReset())

  it('issues a JSON-Patch PATCH with System.State = "Active" for In Progress', async () => {
    fetchMock.mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsTracker.transition('99', 'In Progress', CONFIG)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dev.azure.com/myorg/MyProject/_apis/wit/workitems/99?api-version=7.1-preview.3')
    expect(init.method).toBe('PATCH')
    expect(init.headers['Content-Type']).toBe('application/json-patch+json')
    const patches = JSON.parse(init.body)
    expect(patches).toEqual([{ op: 'add', path: '/fields/System.State', value: 'Active' }])
  })

  it('maps "In Review" to the "Closed" terminal state (best-effort)', async () => {
    fetchMock.mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsTracker.transition('99', 'In Review', CONFIG)
    const [, init] = fetchMock.mock.calls[0]
    const patches = JSON.parse(init.body)
    expect(patches[0].value).toBe('Closed')
  })

  it('swallows non-2xx transitions (process-template-specific state names)', async () => {
    fetchMock.mockResolvedValueOnce(errorResp(400, 'State Closed is not valid'))
    // Should NOT throw — the dev line treats transitions as best-effort.
    await expect(azureDevOpsTracker.transition('1', 'In Review', CONFIG)).resolves.toBeUndefined()
  })

  it('skips the PATCH when no project is configured (cross-project state names are ambiguous)', async () => {
    await azureDevOpsTracker.transition('1', 'In Progress', { org: 'o', project: '', pat: 'p' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('azureDevOpsTracker.checkAuth', () => {
  beforeEach(() => fetchMock.mockReset())

  it('reports "no organization set" without hitting the network', async () => {
    const r = await azureDevOpsTracker.checkAuth({ org: '', pat: 'p' })
    expect(r).toEqual({ ok: false, detail: 'no organization set in Tracker settings' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports "no PAT set" without hitting the network', async () => {
    const r = await azureDevOpsTracker.checkAuth({ org: 'o', pat: '' })
    expect(r).toEqual({ ok: false, detail: 'no PAT set in Tracker settings' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns ok=true with project count on a 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ value: [{ id: 'p1' }, { id: 'p2' }, { id: 'p3' }] }))
    const r = await azureDevOpsTracker.checkAuth({ org: 'myorg', pat: 'p' })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('myorg')
    expect(r.detail).toContain('3 projects')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dev.azure.com/myorg/_apis/projects?api-version=7.1-preview.4')
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from(':p').toString('base64'))
  })

  it('returns ok=false with error context on a 401', async () => {
    fetchMock.mockResolvedValueOnce(errorResp(401, 'TF400813: unauthorized'))
    const r = await azureDevOpsTracker.checkAuth({ org: 'o', pat: 'p' })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/HTTP 401/)
  })
})
