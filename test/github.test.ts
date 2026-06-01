import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock the exec layer so we can inspect the args passed to `gh`.
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('../src/main/util/exec', () => ({ exec: execMock, execOrThrow: vi.fn() }))

import {
  listReviewRequestedPrs,
  getAdoptablePr,
  findPrForTask
} from '../src/main/integrations/github'

describe('listReviewRequestedPrs', () => {
  beforeEach(() => execMock.mockReset())

  it('passes the search filter as a SINGLE argument (so -author:@me is not parsed as a flag)', async () => {
    execMock.mockResolvedValue({ stdout: '[]', stderr: '', code: 0 })
    const filter = 'is:open is:pr review-requested:@me -author:@me'
    await listReviewRequestedPrs(filter)

    const [cmd, args] = execMock.mock.calls[0]
    expect(cmd).toBe('gh')
    // The whole filter is one element...
    expect(args).toContain(filter)
    // ...never split into a standalone `-author:@me` token (the original bug).
    expect(args).not.toContain('-author:@me')
    expect(args).not.toContain('is:open')
  })

  it('parses repository.nameWithOwner and author.login from gh JSON', async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix thing',
          author: { login: 'octocat' },
          repository: { nameWithOwner: 'acme/widgets' }
        }
      ]),
      stderr: '',
      code: 0
    })
    const prs = await listReviewRequestedPrs('whatever')
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({ number: 42, author: 'octocat', repoNameWithOwner: 'acme/widgets' })
  })

  it('throws with stderr context on non-zero exit', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: 'boom', code: 1 })
    await expect(listReviewRequestedPrs('x')).rejects.toThrow(/boom/)
  })
})

describe('getAdoptablePr', () => {
  beforeEach(() => execMock.mockReset())

  it('returns branch/draft/state for a PR by number', async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify({
        number: 7,
        url: 'https://github.com/acme/widgets/pull/7',
        headRefName: 'feature/x',
        isDraft: true,
        state: 'OPEN',
        title: 'WIP'
      }),
      stderr: '',
      code: 0
    })
    const pr = await getAdoptablePr('acme/widgets', 7)
    expect(pr).toMatchObject({ number: 7, branch: 'feature/x', isDraft: true, state: 'OPEN' })
  })

  it('returns null when gh exits non-zero (PR not found)', async () => {
    execMock.mockResolvedValue({ stdout: '', stderr: 'not found', code: 1 })
    expect(await getAdoptablePr('acme/widgets', 999)).toBeNull()
  })
})

describe('findPrForTask', () => {
  beforeEach(() => execMock.mockReset())

  it('searches open PRs by issue key and prefers a branch carrying the key', async () => {
    execMock.mockResolvedValue({
      stdout: JSON.stringify([
        { number: 1, url: 'u1', headRefName: 'misc/cleanup', isDraft: false, state: 'OPEN', title: 'mentions LDWF-9' },
        { number: 2, url: 'u2', headRefName: 'feat/LDWF-9-thing', isDraft: false, state: 'OPEN', title: 'thing' }
      ]),
      stderr: '',
      code: 0
    })
    const pr = await findPrForTask('acme/widgets', 'LDWF-9')
    const [, args] = execMock.mock.calls[0]
    expect(args).toContain('LDWF-9')
    expect(args).toContain('--state')
    // The branch-matching PR wins over the merely-mentioning one.
    expect(pr?.number).toBe(2)
  })

  it('returns null when nothing matches', async () => {
    execMock.mockResolvedValue({ stdout: '[]', stderr: '', code: 0 })
    expect(await findPrForTask('acme/widgets', 'LDWF-9')).toBeNull()
  })
})
