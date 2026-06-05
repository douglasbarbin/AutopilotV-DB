import { describe, it, expect } from 'vitest'
import { ReviewResultSchema, StallDecisionSchema } from '../src/main/llm/provider'
import { resolveInjection, DEFAULT_NUDGE } from '../src/main/brain/stall'

describe('ReviewResultSchema', () => {
  it('accepts a well-formed review', () => {
    const r = ReviewResultSchema.parse({
      recommendation: 'approve',
      summary: 'Looks good.',
      findings: [{ severity: 'minor', file: 'src/x.ts', line: 4, note: 'nit' }]
    })
    expect(r.recommendation).toBe('approve')
    expect(r.findings).toHaveLength(1)
  })

  it('rejects an invalid recommendation', () => {
    expect(() =>
      ReviewResultSchema.parse({ recommendation: 'lgtm', summary: 's', findings: [] })
    ).toThrow()
  })

  it('allows findings without a line number', () => {
    const r = ReviewResultSchema.parse({
      recommendation: 'comment',
      summary: 's',
      findings: [{ severity: 'info', file: 'README.md', note: 'typo' }]
    })
    expect(r.findings[0].line).toBeUndefined()
  })
})

describe('StallDecisionSchema', () => {
  it('parses a respond decision', () => {
    const d = StallDecisionSchema.parse({
      action: 'respond',
      response: 'y',
      reason: 'confirmation prompt'
    })
    expect(d.action).toBe('respond')
    expect(d.response).toBe('y')
  })

  it('parses a nudge decision with a null response', () => {
    const d = StallDecisionSchema.parse({ action: 'nudge', response: null, reason: 'went quiet' })
    expect(d.action).toBe('nudge')
    expect(d.response).toBeNull()
  })

  it('rejects an unknown action', () => {
    expect(() =>
      StallDecisionSchema.parse({ action: 'inject', response: 'y', reason: 'x' })
    ).toThrow()
  })
})

describe('resolveInjection', () => {
  it('answers a prompt with the given response', () => {
    expect(resolveInjection({ action: 'respond', response: '1', reason: 'menu' })).toEqual({
      kind: 'respond',
      text: '1'
    })
  })

  it('escalates a respond decision that has no response to send', () => {
    expect(resolveInjection({ action: 'respond', response: null, reason: 'unsure' })).toEqual({
      kind: 'escalate'
    })
  })

  it('uses the model nudge text when provided', () => {
    expect(
      resolveInjection({ action: 'nudge', response: 'continue with step 2', reason: 'idle' })
    ).toEqual({ kind: 'nudge', text: 'continue with step 2' })
  })

  it('falls back to the default nudge when none is given', () => {
    expect(resolveInjection({ action: 'nudge', response: null, reason: 'idle' })).toEqual({
      kind: 'nudge',
      text: DEFAULT_NUDGE
    })
  })

  it('passes through wait and escalate', () => {
    expect(resolveInjection({ action: 'wait', response: null, reason: 'building' })).toEqual({
      kind: 'wait'
    })
    expect(resolveInjection({ action: 'escalate', response: null, reason: 'broken' })).toEqual({
      kind: 'escalate'
    })
  })
})
