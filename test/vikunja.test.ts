import { vi, describe, it, expect, beforeEach } from 'vitest'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.stubGlobal('fetch', fetchMock)

import { vikunjaTracker } from '../src/main/trackers/vikunja'

type FetchResp = {
  ok: boolean
  status: number
  headers: { get: (k: string) => string | null }
  json: () => Promise<unknown>
}

function jsonResp(body: unknown, opts: { ok?: boolean; status?: number; totalPages?: number } = {}): FetchResp {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    headers: {
      get: (k: string) => (k.toLowerCase() === 'x-pagination-total-pages' ? String(opts.totalPages ?? 1) : null)
    },
    json: async () => body
  }
}

const CONFIG = {
  endpoint: 'https://vikunja.example.com',
  token: 'tk_test',
  projectId: '',
  assigneeFilter: 'justinwoodring'
}

const SAMPLE_TASK = {
  id: 1,
  title: 'Add support for Azure Devops',
  done: false,
  percent_done: 0,
  priority: 0,
  project_id: 2,
  assignees: null,
  labels: null,
  created_by: { id: 1, username: 'justinwoodring' }
}

const PROJECTS = [
  { id: 1, title: 'Inbox', owner: { username: 'justinwoodring' } },
  { id: 2, title: 'AutopilotV', owner: { username: 'justinwoodring' } }
]

/** Convenience: queue the standard projects-list response so listAssigned tests stay one-liner-ish. */
function queueProjects() {
  fetchMock.mockResolvedValueOnce(jsonResp(PROJECTS, { totalPages: 1 }))
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('vikunjaTracker.listAssigned', () => {
  it('hits /api/v1/tasks (not /api/v1/tasks/all) and follows pagination', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://vikunja.example.com/api/v1/projects?per_page=50')
    expect(fetchMock.mock.calls[1][0]).toBe('https://vikunja.example.com/api/v1/tasks?per_page=50&page=1')
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe('Bearer tk_test')
  })

  it('walks all pages when X-Pagination-Total-Pages > 1', async () => {
    queueProjects()
    fetchMock
      .mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 3 }))
      .mockResolvedValueOnce(jsonResp([{ ...SAMPLE_TASK, id: 2, title: 't2' }], { ok: true, status: 200 }))
      .mockResolvedValueOnce(jsonResp([{ ...SAMPLE_TASK, id: 3, title: 't3' }], { ok: true, status: 200 }))
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(3)
    expect(fetchMock).toHaveBeenCalledTimes(4) // projects + 3 pages
    expect(fetchMock.mock.calls[2][0]).toBe('https://vikunja.example.com/api/v1/tasks?per_page=50&page=2')
    expect(fetchMock.mock.calls[3][0]).toBe('https://vikunja.example.com/api/v1/tasks?per_page=50&page=3')
  })

  it('uses /api/v1/projects/{id}/tasks when projectId is set', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp([], { totalPages: 1 }))
    await vikunjaTracker.listAssigned({ ...CONFIG, projectId: '7' })
    expect(fetchMock.mock.calls[0][0]).toBe('https://vikunja.example.com/api/v1/projects?per_page=50')
    expect(fetchMock.mock.calls[1][0]).toBe('https://vikunja.example.com/api/v1/projects/7/tasks?per_page=50&page=1')
  })

  it('falls back to created_by.username when assignees is null', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const [issue] = await vikunjaTracker.listAssigned(CONFIG)
    expect(issue.assignee).toBe('justinwoodring')
    expect(issue.key).toBe('1')
    expect(issue.projectKey).toBe('2')
  })

  it('resolves projectName to the project title (not the ID)', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const [issue] = await vikunjaTracker.listAssigned(CONFIG)
    expect(issue.projectKey).toBe('2')
    expect(issue.projectName).toBe('AutopilotV')
  })

  it('falls back to the project ID as the name when the project is not in the projects list', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ ...SAMPLE_TASK, project_id: 99 }], { totalPages: 1 })
    )
    const [issue] = await vikunjaTracker.listAssigned(CONFIG)
    expect(issue.projectKey).toBe('99')
    expect(issue.projectName).toBe('99')
  })

  it('still works when the projects lookup fails (name falls back to ID)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResp(null, { ok: false, status: 500 }))
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const [issue] = await vikunjaTracker.listAssigned(CONFIG)
    expect(issue.projectKey).toBe('2')
    expect(issue.projectName).toBe('2')
  })

  it('matches by created_by when no assignees are present (unassigned tasks)', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(1)
  })

  it('matches by an explicit assignees[] entry as well', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        [{ ...SAMPLE_TASK, created_by: { id: 9, username: 'someone-else' }, assignees: [{ username: 'justinwoodring' }] }],
        { totalPages: 1 }
      )
    )
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(1)
  })

  it('drops a task that has neither matching assignees nor matching creator', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(
      jsonResp(
        [{ ...SAMPLE_TASK, created_by: { id: 9, username: 'someone-else' }, assignees: [{ username: 'another-person' }] }],
        { totalPages: 1 }
      )
    )
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(0)
  })

  it('filters out done tasks', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ ...SAMPLE_TASK, done: true }], { totalPages: 1 })
    )
    const issues = await vikunjaTracker.listAssigned(CONFIG)
    expect(issues).toHaveLength(0)
  })

  it('resolves the current username from /api/v1/user when assigneeFilter is empty', async () => {
    queueProjects()
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 1, username: 'justinwoodring' }))
    fetchMock.mockResolvedValueOnce(jsonResp([SAMPLE_TASK], { totalPages: 1 }))
    const issues = await vikunjaTracker.listAssigned({ ...CONFIG, assigneeFilter: '' })
    expect(issues).toHaveLength(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://vikunja.example.com/api/v1/projects?per_page=50')
    expect(fetchMock.mock.calls[1][0]).toBe('https://vikunja.example.com/api/v1/user')
  })

  it('returns no issues (and does not call fetch) when endpoint or token is missing', async () => {
    expect(await vikunjaTracker.listAssigned({ ...CONFIG, endpoint: '' })).toEqual([])
    expect(await vikunjaTracker.listAssigned({ ...CONFIG, token: '' })).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('vikunjaTracker.checkAuth', () => {
  it('returns ok with the current username resolved from /api/v1/user', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 1, username: 'justinwoodring' }))
    const r = await vikunjaTracker.checkAuth(CONFIG)
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('https://vikunja.example.com (justinwoodring)')
    expect(fetchMock.mock.calls[0][0]).toBe('https://vikunja.example.com/api/v1/user')
  })

  it('returns ok with just the endpoint when /user has no username field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 1 }))
    const r = await vikunjaTracker.checkAuth(CONFIG)
    expect(r.ok).toBe(true)
    expect(r.detail).toBe('https://vikunja.example.com')
  })

  it('returns down when no endpoint is configured', async () => {
    const r = await vikunjaTracker.checkAuth({ ...CONFIG, endpoint: '' })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no endpoint/)
  })

  it('returns down when no token is configured', async () => {
    const r = await vikunjaTracker.checkAuth({ ...CONFIG, token: '' })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no API token/)
  })

  it('returns down with the upstream error when /user fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(null, { ok: false, status: 401 }))
    const r = await vikunjaTracker.checkAuth(CONFIG)
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/HTTP 401/)
  })
})

describe('vikunjaTracker.transition', () => {
  /**
   * Queue the standard 4-step flow for a successful bucket move + percent_done update:
   *   1. GET  /api/v1/tasks/{key}         → resolve project_id
   *   2. GET  /api/v1/projects/{pid}/views → find kanban view
   *   3. GET  .../views/{vid}/buckets     → find the "In Progress" bucket
   *   4. POST .../buckets/{bid}/tasks      → add the task to that bucket
   *   5. POST /api/v1/tasks/{key}         → set percent_done
   */
  function queueHappyBucketMove(taskProjectId = 2) {
    fetchMock.mockResolvedValueOnce(jsonResp({ ...SAMPLE_TASK, id: 42, project_id: taskProjectId }))
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ id: 8, view_kind: 'kanban' }, { id: 5, view_kind: 'list' }])
    )
    fetchMock.mockResolvedValueOnce(
      jsonResp([
        { id: 4, title: 'To-Do' },
        { id: 5, title: 'In Progress' },
        { id: 6, title: 'Done' }
      ])
    )
    fetchMock.mockResolvedValueOnce(jsonResp(null, { ok: true, status: 200 }))
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 }))
  }

  it('moves the task to the "In Progress" bucket and sets percent_done=0.5', async () => {
    queueHappyBucketMove()
    await vikunjaTracker.transition('42', 'In Progress', CONFIG)

    // Step 1: GET task to find project_id
    expect(fetchMock.mock.calls[0][0]).toBe('https://vikunja.example.com/api/v1/tasks/42')
    expect(fetchMock.mock.calls[0][1].method).toBe('GET')

    // Step 2: GET views
    expect(fetchMock.mock.calls[1][0]).toBe('https://vikunja.example.com/api/v1/projects/2/views')
    expect(fetchMock.mock.calls[1][1].method).toBe('GET')

    // Step 3: GET buckets
    expect(fetchMock.mock.calls[2][0]).toBe('https://vikunja.example.com/api/v1/projects/2/views/8/buckets')
    expect(fetchMock.mock.calls[2][1].method).toBe('GET')

    // Step 4: POST to bucket/tasks
    const [bucketUrl, bucketInit] = fetchMock.mock.calls[3]
    expect(bucketUrl).toBe('https://vikunja.example.com/api/v1/projects/2/views/8/buckets/5/tasks')
    expect(bucketInit.method).toBe('POST')
    expect(JSON.parse(bucketInit.body)).toEqual({ task_id: 42 })

    // Step 5: POST percent_done
    const [taskUrl, taskInit] = fetchMock.mock.calls[4]
    expect(taskUrl).toBe('https://vikunja.example.com/api/v1/tasks/42')
    expect(taskInit.method).toBe('POST')
    expect(JSON.parse(taskInit.body)).toEqual({ done: false, percent_done: 0.5 })
  })

  it('uses percent_done=0.75 for "In Review" (same bucket, different progress)', async () => {
    queueHappyBucketMove()
    await vikunjaTracker.transition('42', 'In Review', CONFIG)
    const last = fetchMock.mock.calls[fetchMock.mock.calls.length - 1]
    expect(JSON.parse(last[1].body)).toEqual({ done: false, percent_done: 0.75 })
  })

  it('matches "Doing" and "WIP" bucket titles too', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ ...SAMPLE_TASK, id: 42, project_id: 2 }))
    fetchMock.mockResolvedValueOnce(jsonResp([{ id: 8, view_kind: 'kanban' }]))
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ id: 4, title: 'To-Do' }, { id: 5, title: 'Doing' }, { id: 6, title: 'Done' }])
    )
    fetchMock.mockResolvedValueOnce(jsonResp(null, { ok: true, status: 200 }))
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 }))

    await vikunjaTracker.transition('42', 'In Progress', CONFIG)
    const [url] = fetchMock.mock.calls[3]
    expect(url).toBe('https://vikunja.example.com/api/v1/projects/2/views/8/buckets/5/tasks')
  })

  it('falls back to percent_done only when the project has no kanban view', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ ...SAMPLE_TASK, id: 42, project_id: 2 }))
    fetchMock.mockResolvedValueOnce(jsonResp([{ id: 5, view_kind: 'list' }])) // no kanban
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 }))

    await vikunjaTracker.transition('42', 'In Progress', CONFIG)
    expect(fetchMock).toHaveBeenCalledTimes(3) // task, views, percent — no bucket call
    const [url, init] = fetchMock.mock.calls[2]
    expect(url).toBe('https://vikunja.example.com/api/v1/tasks/42')
    expect(JSON.parse(init.body)).toEqual({ done: false, percent_done: 0.5 })
  })

  it('falls back to percent_done only when no In Progress bucket exists', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ ...SAMPLE_TASK, id: 42, project_id: 2 }))
    fetchMock.mockResolvedValueOnce(jsonResp([{ id: 8, view_kind: 'kanban' }]))
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ id: 4, title: 'Backlog' }, { id: 6, title: 'Shipped' }]) // no in-flight
    )
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 }))

    await vikunjaTracker.transition('42', 'In Progress', CONFIG)
    expect(fetchMock).toHaveBeenCalledTimes(4) // task, views, buckets, percent — no bucket-add call
    const last = fetchMock.mock.calls[3]
    expect(last[0]).toBe('https://vikunja.example.com/api/v1/tasks/42')
  })

  it('still sets percent_done when the bucket-move call itself errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp({ ...SAMPLE_TASK, id: 42, project_id: 2 }))
    fetchMock.mockResolvedValueOnce(jsonResp([{ id: 8, view_kind: 'kanban' }]))
    fetchMock.mockResolvedValueOnce(
      jsonResp([{ id: 4, title: 'To-Do' }, { id: 5, title: 'In Progress' }, { id: 6, title: 'Done' }])
    )
    fetchMock.mockResolvedValueOnce(jsonResp(null, { ok: false, status: 500 })) // bucket-add fails
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 })) // percent still happens

    await expect(vikunjaTracker.transition('42', 'In Progress', CONFIG)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const last = fetchMock.mock.calls[4]
    expect(last[0]).toBe('https://vikunja.example.com/api/v1/tasks/42')
    expect(JSON.parse(last[1].body)).toEqual({ done: false, percent_done: 0.5 })
  })

  it('still sets percent_done when the initial task lookup errors', async () => {
    fetchMock.mockResolvedValueOnce(jsonResp(null, { ok: false, status: 404 }))
    fetchMock.mockResolvedValueOnce(jsonResp({ id: 42, percent_done: 0.5 }))

    await vikunjaTracker.transition('42', 'In Progress', CONFIG)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const last = fetchMock.mock.calls[1]
    expect(last[0]).toBe('https://vikunja.example.com/api/v1/tasks/42')
    expect(JSON.parse(last[1].body)).toEqual({ done: false, percent_done: 0.5 })
  })

  it('is a no-op (no fetch) when endpoint or token is missing', async () => {
    await vikunjaTracker.transition('42', 'In Progress', { ...CONFIG, endpoint: '' })
    await vikunjaTracker.transition('42', 'In Progress', { ...CONFIG, token: '' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
