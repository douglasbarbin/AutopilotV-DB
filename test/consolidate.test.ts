/**
 * Knowledge consolidation: LLM-curated merges/retires plus the deterministic
 * active-set cap, and the once-per-interval gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  BrowserWindow: class {},
  Notification: { isSupported: () => false }
}))

const { judgeMock } = vi.hoisted(() => ({ judgeMock: vi.fn() }))
vi.mock('../src/main/llm/provider', () => ({
  judgeValidated: judgeMock,
  makeProvider: vi.fn(() => ({ kind: 'local', judge: vi.fn() }))
}))

import { __openInMemoryDbForTesting, closeDb } from '../src/main/db'
import * as store from '../src/main/store'
import {
  consolidateKnowledge,
  maybeConsolidateKnowledge,
  ACTIVE_CAP
} from '../src/main/analysis/consolidate'

function seedRepoId(): number {
  return store.upsertRepo({
    name: 'owner/repo',
    remote: 'https://example.com/owner/repo.git',
    defaultBranch: 'main',
    path: null,
    forge: 'github'
  }).id
}

describe('consolidateKnowledge', () => {
  beforeEach(() => {
    __openInMemoryDbForTesting()
    store.seedIfEmpty()
    judgeMock.mockReset()
  })
  afterEach(() => closeDb())

  it('caps the active set even when the LLM pass fails', async () => {
    const repoId = seedRepoId()
    judgeMock.mockRejectedValue(new Error('no llm'))
    for (let i = 0; i < ACTIVE_CAP + 3; i++) {
      const id = store.insertKnowledge({ repoId, role: 'coding', insight: `Insight number ${i}` })!
      store.setKnowledgeStatus(id, 'active')
    }

    const res = await consolidateKnowledge(store.getSettings())

    expect(res.retired).toBe(3)
    expect(store.listKnowledge('active')).toHaveLength(ACTIVE_CAP)
  })

  it('merges duplicate insights into one consolidated item and retires the members', async () => {
    const repoId = seedRepoId()
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(store.insertKnowledge({ repoId, role: 'coding', insight: `Use pnpm variant ${i}` })!)
    }
    store.setKnowledgeStatus(ids[0], 'active')
    judgeMock.mockResolvedValue({
      retire: [ids[4]],
      merges: [{ ids: [ids[0], ids[1]], insight: 'Use pnpm, never npm', confidence: 'high' }]
    })

    const res = await consolidateKnowledge(store.getSettings())

    expect(res.merged).toBe(1)
    const all = store.listKnowledge()
    const consolidated = all.find((k) => k.insight === 'Use pnpm, never npm')!
    expect(consolidated.source).toBe('consolidation')
    // One member was active, so the consolidated item stays active.
    expect(consolidated.status).toBe('active')
    expect(all.find((k) => k.id === ids[0])!.status).toBe('retired')
    expect(all.find((k) => k.id === ids[1])!.status).toBe('retired')
    expect(all.find((k) => k.id === ids[4])!.status).toBe('retired')
    // Untouched members survive.
    expect(all.find((k) => k.id === ids[2])!.status).toBe('candidate')
  })

  it('ignores LLM ids outside the group', async () => {
    const repoId = seedRepoId()
    const ids: number[] = []
    for (let i = 0; i < 5; i++) {
      ids.push(store.insertKnowledge({ repoId, role: 'coding', insight: `Thing ${i}` })!)
    }
    judgeMock.mockResolvedValue({ retire: [9999], merges: [{ ids: [9999, 8888], insight: 'bogus', confidence: 'low' }] })

    const res = await consolidateKnowledge(store.getSettings())

    expect(res).toEqual({ retired: 0, merged: 0 })
    expect(store.listKnowledge().every((k) => k.status !== 'retired')).toBe(true)
  })

  it('maybeConsolidateKnowledge runs at most once per interval', async () => {
    seedRepoId()
    judgeMock.mockRejectedValue(new Error('no llm'))
    await maybeConsolidateKnowledge(store.getSettings())
    const stamp = store.kvRead('knowledge.lastConsolidatedAt')
    expect(stamp).toBeTruthy()
    // Second call inside the interval leaves the stamp untouched.
    await new Promise((r) => setTimeout(r, 5))
    await maybeConsolidateKnowledge(store.getSettings())
    expect(store.kvRead('knowledge.lastConsolidatedAt')).toBe(stamp)
  })
})
