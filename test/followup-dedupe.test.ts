/**
 * Semantic follow-up dedupe: reworded re-suggestions (the same idea phrased
 * differently each address-comments round) are dropped against the repo's
 * existing follow-ups — including dismissed and created ones.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false },
  safeStorage: undefined
}))

const { judgeMock } = vi.hoisted(() => ({ judgeMock: vi.fn() }))
vi.mock('../src/main/llm/provider', () => ({
  judgeValidated: judgeMock,
  makeProvider: vi.fn(() => ({ kind: 'local', judge: vi.fn() }))
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import { harvestSignalReport } from '../src/main/analysis/engine'
import type { TrackerTask } from '../src/shared/types/domain'

function seedTask(): TrackerTask {
  const { id } = store.upsertTask({
    issueKey: 'TXRI-806',
    title: 'Task',
    status: 'todo',
    trackerStatus: 'To Do',
    issueType: 'Story',
    projectKey: 'TXRI'
  })
  const repo = store.upsertRepo({
    name: 'GoValidate/Wallet',
    remote: 'https://example.com/w.git',
    defaultBranch: 'main',
    path: null,
    forge: 'github'
  })
  store.setTaskRepo(id, repo.id)
  return store.getTask(id)!
}

const report = (title: string) => ({
  version: 1,
  summary: '',
  deviations: '',
  followUps: [{ title, description: 'notification literals in StartSessionHandler', kind: 'tech_debt' as const, priority: 'low' as const, files: [] }],
  learnings: []
})

describe('semantic follow-up dedupe', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    judgeMock.mockReset()
  })
  afterEach(() => closeDb())

  it('drops a reworded re-suggestion, even against a DISMISSED original', async () => {
    const task = seedTask()
    await harvestSignalReport(task, report('Move RI staff-push notification text to standard resource files'))
    const original = store.listFollowUps()[0]
    store.setFollowUpStatus(original.id, 'dismissed') // "stop suggesting this"

    judgeMock.mockImplementation(async () => ({
      duplicates: [
        {
          newId: store.listFollowUps().find((f) => f.title.includes('Extract'))!.id,
          duplicateOf: original.id
        }
      ]
    }))
    const res = await harvestSignalReport(task, report('Extract notification literals to resource files'))

    expect(res.followUps).toBe(0) // recognized as a duplicate, dropped
    expect(store.listFollowUps()).toHaveLength(1) // only the dismissed original remains
    expect(judgeMock).toHaveBeenCalledTimes(1)
  })

  it('keeps genuinely new suggestions when the judge finds no duplicates', async () => {
    const task = seedTask()
    await harvestSignalReport(task, report('Move notification text to resource files'))
    judgeMock.mockResolvedValue({ duplicates: [] })
    const res = await harvestSignalReport(task, report('Add retry to the push notification sender'))
    expect(res.followUps).toBe(1)
    expect(store.listFollowUps()).toHaveLength(2)
  })

  it('degrades to hash-only dedupe when the LLM is unreachable', async () => {
    const task = seedTask()
    await harvestSignalReport(task, report('Move notification text to resource files'))
    judgeMock.mockRejectedValue(new Error('no llm'))
    const res = await harvestSignalReport(task, report('Relocate the notification strings into resources'))
    expect(res.followUps).toBe(1) // kept — better noisy than silently lost
    expect(store.listFollowUps()).toHaveLength(2)
  })

  it('hash dedupe needs no LLM at all for identical titles', async () => {
    const task = seedTask()
    await harvestSignalReport(task, report('Move notification text to resource files'))
    judgeMock.mockReset()
    const res = await harvestSignalReport(task, report('Move notification text to resource files'))
    expect(res.followUps).toBe(0)
    expect(judgeMock).not.toHaveBeenCalled() // nothing new inserted → no judgment
  })
})
