import { describe, it, expect } from 'vitest'
import { detectStall, violatesDenylist } from '../src/main/brain/stall'
import type { HarnessConfig } from '@shared/types/domain'

const harness: HarnessConfig = {
  id: 'test',
  displayName: 'Test',
  enabled: true,
  isReviewDefault: false,
  isBrainDefault: false,
  isCodingDefault: false,
  launch: { command: 'echo', args: [] },
  stall: { idleSeconds: 30, waitingPatterns: ['\\(y/n\\)', 'Continue\\?'] },
  inject: { method: 'stdin', submitKey: '\r' }
}

describe('detectStall', () => {
  it('flags a waiting prompt regardless of idle time', () => {
    const s = detectStall(harness, 1, 'Do it now (y/n) ')
    expect(s.isCandidate).toBe(true)
    expect(s.reason).toBe('waiting_pattern')
    expect(s.matchedPattern).toBe('\\(y/n\\)')
  })

  it('flags idle sessions past the threshold', () => {
    const s = detectStall(harness, 45, 'working...')
    expect(s.isCandidate).toBe(true)
    expect(s.reason).toBe('idle')
  })

  it('does not flag an active session with no waiting prompt', () => {
    const s = detectStall(harness, 5, 'compiling module 3 of 10')
    expect(s.isCandidate).toBe(false)
  })

  it('ignores invalid regex patterns without throwing', () => {
    const bad = { ...harness, stall: { idleSeconds: 30, waitingPatterns: ['([invalid'] } }
    expect(() => detectStall(bad, 5, 'x')).not.toThrow()
  })
})

describe('violatesDenylist', () => {
  const denylist = ['rm -rf', 'git push --force', 'drop table']

  it('blocks a destructive proposed response', () => {
    expect(violatesDenylist(denylist, 'rm -rf /', 'context')).toBe('rm -rf')
  })

  it('blocks when the context around the prompt is destructive', () => {
    expect(violatesDenylist(denylist, 'y', 'Proceed to DROP TABLE users? (y/n)')).toBe('drop table')
  })

  it('allows a benign confirmation', () => {
    expect(violatesDenylist(denylist, 'y', 'Continue installing deps? (y/n)')).toBeNull()
  })
})
