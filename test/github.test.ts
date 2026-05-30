import { vi, describe, it, expect, beforeEach } from 'vitest'

// Mock the exec layer so we can inspect the args passed to `gh`.
const { execMock } = vi.hoisted(() => ({ execMock: vi.fn() }))
vi.mock('../src/main/util/exec', () => ({ exec: execMock, execOrThrow: vi.fn() }))

import { listReviewRequestedPrs } from '../src/main/integrations/github'

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
