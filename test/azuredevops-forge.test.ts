import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock the env logger so test output stays clean.
vi.mock('../src/main/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

// Replace the `fetch` global with a hoisted spy so we can assert on requests
// without touching the real network.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.stubGlobal('fetch', fetchMock)

import { azureDevOpsForge, splitRepo, buildPrUrl, __resetRepoIdCache } from '../src/main/forges/azuredevops'

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

const CONFIG = { org: 'myorg', project: 'MyProject', pat: 'pat123', reviewerFilter: '' }

describe('splitRepo / buildPrUrl', () => {
  it('parses 3-segment names into org/project/repo', () => {
    expect(splitRepo('myorg/MyProject/widgets', '')).toEqual({
      org: 'myorg',
      project: 'MyProject',
      repo: 'widgets'
    })
  })
  it('falls back to config.project for 2-segment names', () => {
    expect(splitRepo('myorg/widgets', 'DefaultProject')).toEqual({
      org: 'myorg',
      project: 'DefaultProject',
      repo: 'widgets'
    })
  })
  it('builds a canonical Azure DevOps PR URL', () => {
    expect(buildPrUrl('myorg', 'MyProject', 'widgets', 42)).toBe(
      'https://dev.azure.com/myorg/MyProject/_git/widgets/pullrequest/42'
    )
  })
})

describe('azureDevOpsForge.checkAuth', () => {
  beforeEach(() => fetchMock.mockReset())

  it('reports missing org without hitting the network', async () => {
    const r = await azureDevOpsForge.checkAuth({ org: '', pat: 'x' })
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports missing PAT without hitting the network', async () => {
    const r = await azureDevOpsForge.checkAuth({ org: 'o', pat: '' })
    expect(r.ok).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns ok with project count on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ value: [{ id: 'p1' }, { id: 'p2' }] }))
    const r = await azureDevOpsForge.checkAuth({ org: 'myorg', pat: 'p' })
    expect(r.ok).toBe(true)
    expect(r.detail).toContain('myorg')
    expect(r.detail).toContain('2 projects')
  })

  it('returns ok=false with detail on 401', async () => {
    fetchMock.mockResolvedValueOnce(errorResp(401, 'TF400813: unauthorized'))
    const r = await azureDevOpsForge.checkAuth({ org: 'o', pat: 'p' })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/HTTP 401/)
  })
})

describe('azureDevOpsForge.getPr', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('resolves the repo GUID then returns head/title/author for a PR', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResp({ id: 'guid-1', name: 'widgets' })
      )
      .mockResolvedValueOnce(
        jsonResp({
          pullRequestId: 42,
          title: 'Fix thing',
          sourceRefName: 'refs/heads/feat/x',
          url: 'https://dev.azure.com/myorg/MyProject/_git/widgets/pullrequest/42',
          createdBy: { displayName: 'Jane Dev' }
        })
      )
    const pr = await azureDevOpsForge.getPr('myorg/MyProject/widgets', 42, CONFIG)
    expect(pr).toMatchObject({
      number: 42,
      title: 'Fix thing',
      headRefName: 'feat/x',
      repoNameWithOwner: 'myorg/MyProject/widgets'
    })
    expect(pr.url).toContain('pullrequest/42')

    // First call: repo GUID lookup. Second: the PR itself.
    const [url1, init1] = fetchMock.mock.calls[0]
    expect(url1).toContain('myorg/MyProject/_apis/git/repositories/widgets')
    expect(init1.headers.Authorization).toBe('Basic ' + Buffer.from(':pat123').toString('base64'))
    const [url2] = fetchMock.mock.calls[1]
    expect(url2).toContain('pullRequests/42')
  })
})

describe('azureDevOpsForge.publishPr', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('issues a JSON-Patch with isDraft = false', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
    fetchMock.mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsForge.publishPr('myorg/MyProject/widgets', 7, CONFIG)
    const [patchUrl, patchInit] = fetchMock.mock.calls[1]
    expect(patchUrl).toContain('pullRequests/7')
    expect(patchInit.method).toBe('PATCH')
    const body = JSON.parse(patchInit.body)
    expect(body).toEqual([{ op: 'replace', path: '/isDraft', value: false }])
  })
})

describe('azureDevOpsForge.mergePr', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('PUTs status=completed with a squash strategy', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
    fetchMock.mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsForge.mergePr('myorg/MyProject/widgets', 9, CONFIG)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toContain('pullRequests/9')
    expect(init.method).toBe('PUT')
    const body = JSON.parse(init.body)
    expect(body.status).toBe('completed')
    expect(body.completionOptions.mergeStrategy).toBe('squash')
  })
})

describe('azureDevOpsForge.getPrReadiness', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('maps an active PR with approvals + 0 unresolved threads → ready', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' })) // repo GUID
      .mockResolvedValueOnce(
        jsonResp({
          pullRequestId: 1,
          status: 'active',
          mergeStatus: 'notConflicts'
        })
      )
      .mockResolvedValueOnce(
        jsonResp([
          { id: 'r1', vote: 10 }, // approved
          { id: 'r2', vote: 5 } // approved-with-suggestions
        ])
      )
      .mockResolvedValueOnce(jsonResp([{ status: 'closed' }, { status: 'active' }])) // threads
    const r = await azureDevOpsForge.getPrReadiness('myorg/MyProject/widgets', 1, CONFIG)
    expect(r.state).toBe('OPEN')
    expect(r.mergeable).toBe(true)
    expect(r.statusOk).toBe(true)
    expect(r.approvals).toBe(2)
    expect(r.changesRequested).toBe(false)
    expect(r.unresolvedThreads).toBe(1)
  })

  it('marks mergeable=false on conflicts and changesRequested=true on -10 vote', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(
        jsonResp({ pullRequestId: 1, status: 'active', mergeStatus: 'conflicts' })
      )
      .mockResolvedValueOnce(jsonResp([{ id: 'r1', vote: -10 }]))
      .mockResolvedValueOnce(jsonResp([]))
    const r = await azureDevOpsForge.getPrReadiness('myorg/MyProject/widgets', 1, CONFIG)
    expect(r.mergeable).toBe(false)
    expect(r.changesRequested).toBe(true)
    expect(r.approvals).toBe(0)
  })

  it('returns MERGED on a completed PR without further calls', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(
        jsonResp({ pullRequestId: 1, status: 'completed', mergeStatus: 'succeeded' })
      )
    const r = await azureDevOpsForge.getPrReadiness('myorg/MyProject/widgets', 1, CONFIG)
    expect(r.state).toBe('MERGED')
  })
})

describe('azureDevOpsForge.findPrForBranch', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('finds an open PR for a head branch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(
        jsonResp([
          {
            pullRequestId: 5,
            sourceRefName: 'refs/heads/feat/x',
            status: 'active',
            isDraft: true,
            url: 'https://dev.azure.com/myorg/MyProject/_git/widgets/pullrequest/5'
          }
        ])
      )
    const r = await azureDevOpsForge.findPrForBranch('myorg/MyProject/widgets', 'feat/x', CONFIG)
    expect(r).toMatchObject({ number: 5, isDraft: true, state: 'OPEN' })
    const [listUrl] = fetchMock.mock.calls[1]
    expect(listUrl).toContain('searchCriteria.sourceRefName=')
    expect(listUrl).toContain('feat')
  })

  it('returns null when no PR matches the branch', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(jsonResp([])) // active
      .mockResolvedValueOnce(jsonResp([])) // all
    const r = await azureDevOpsForge.findPrForBranch('myorg/MyProject/widgets', 'feat/x', CONFIG)
    expect(r).toBeNull()
  })
})

describe('azureDevOpsForge.submitReview', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    __resetRepoIdCache()
  })

  it('comment-only review creates a new thread (no vote change)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsForge.submitReview(
      'myorg/MyProject/widgets',
      1,
      'comment',
      'Looks good to me',
      CONFIG
    )
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toContain('pullRequests/1/threads')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.comments[0].content).toBe('Looks good to me')
    // No additional call to /reviewers for comments.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('approve sets vote=10 on the existing reviewer record', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(
        jsonResp({ authenticatedUser: { id: 'user-id' } })
      )
      .mockResolvedValueOnce(jsonResp([{ id: 'user-id', vote: 0 }]))
      .mockResolvedValueOnce(emptyResp(200))
      .mockResolvedValueOnce(emptyResp(200)) // comment thread
    await azureDevOpsForge.submitReview('myorg/MyProject/widgets', 1, 'approve', 'LGTM', CONFIG)
    const [voteUrl, voteInit] = fetchMock.mock.calls[3]
    expect(voteUrl).toContain('reviewers/user-id')
    expect(voteInit.method).toBe('PUT')
    const body = JSON.parse(voteInit.body)
    expect(body.vote).toBe(10)
  })

  it('request_changes sets vote=-10', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp({ id: 'guid-1' }))
      .mockResolvedValueOnce(jsonResp({ authenticatedUser: { id: 'user-id' } }))
      .mockResolvedValueOnce(jsonResp([{ id: 'user-id', vote: 0 }]))
      .mockResolvedValueOnce(emptyResp(200))
      .mockResolvedValueOnce(emptyResp(200))
    await azureDevOpsForge.submitReview(
      'myorg/MyProject/widgets',
      1,
      'request_changes',
      'Needs work',
      CONFIG
    )
    const [, voteInit] = fetchMock.mock.calls[3]
    const body = JSON.parse(voteInit.body)
    expect(body.vote).toBe(-10)
  })
})
