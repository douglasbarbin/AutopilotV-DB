import { describe, it, expect } from 'vitest'
import { detectStall, resolveInjection, violatesDenylist } from '../src/main/brain/stall'
import { normalizeTerminalText } from '../src/main/util/ansi'
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

  it('matches a waiting prompt interleaved with ANSI color codes', () => {
    const tail = 'Apply changes? \x1b[1m\x1b[32m(y\x1b[0m/\x1b[31mn)\x1b[0m '
    const s = detectStall(harness, 1, tail)
    expect(s.isCandidate).toBe(true)
    expect(s.reason).toBe('waiting_pattern')
  })

  it('matches a prompt repainted over a spinner line with carriage returns', () => {
    const tail = '⠋ thinking…\r⠙ thinking…\rContinue? (y/n) '
    const s = detectStall(harness, 1, tail)
    expect(s.isCandidate).toBe(true)
    expect(s.reason).toBe('waiting_pattern')
  })
})

describe('normalizeTerminalText', () => {
  it('strips CSI and OSC sequences', () => {
    const raw = '\x1b]0;title\x07\x1b[2J\x1b[1;32mhello\x1b[0m world'
    expect(normalizeTerminalText(raw)).toBe('hello world')
  })

  it('keeps only the visible segment after carriage-return repaints', () => {
    expect(normalizeTerminalText('10%\r50%\r100% done')).toBe('100% done')
    expect(normalizeTerminalText('line1\nspin\rfinal\nline3')).toBe('line1\nfinal\nline3')
  })
})

describe('resolveInjection', () => {
  it('maps press_keys with valid keys to a keys plan', () => {
    const plan = resolveInjection({ action: 'press_keys', response: null, keys: ['Enter', 'down'], reason: 'menu' })
    expect(plan).toEqual({ kind: 'keys', keys: ['enter', 'down'] })
  })

  it('escalates press_keys with no usable keys', () => {
    expect(resolveInjection({ action: 'press_keys', response: null, keys: ['ctrl+c'], reason: 'x' })).toEqual({
      kind: 'escalate'
    })
    expect(resolveInjection({ action: 'press_keys', response: null, keys: null, reason: 'x' })).toEqual({
      kind: 'escalate'
    })
  })

  it('escalates respond with an empty response', () => {
    expect(resolveInjection({ action: 'respond', response: null, reason: 'x' })).toEqual({ kind: 'escalate' })
  })

  it('nudge falls back to the default wording', () => {
    const plan = resolveInjection({ action: 'nudge', response: null, reason: 'quiet' })
    expect(plan.kind).toBe('nudge')
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
