import { describe, it, expect } from 'vitest'
import { ReviewResultSchema, StallDecisionSchema } from '../src/main/llm/provider'

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
  it('parses an inject decision', () => {
    const d = StallDecisionSchema.parse({
      waitingForInput: true,
      response: 'y',
      escalate: false,
      reason: 'confirmation prompt'
    })
    expect(d.response).toBe('y')
  })

  it('parses an escalate decision with null response', () => {
    const d = StallDecisionSchema.parse({
      waitingForInput: true,
      response: null,
      escalate: true,
      reason: 'ambiguous'
    })
    expect(d.escalate).toBe(true)
  })
})
