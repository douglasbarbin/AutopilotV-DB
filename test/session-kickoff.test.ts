import { describe, it, expect } from 'vitest'
import { HARNESS_STARTUP_DELAY_MS, HARNESS_SUBMIT_DELAY_MS } from '../src/main/sessions/kickoff'

describe('session kickoff timing', () => {
  it('waits ~2 seconds for the harness TUI to spin up before typing the prompt', () => {
    expect(HARNESS_STARTUP_DELAY_MS).toBe(2000)
  })

  it('waits ~1 second between typing the prompt and pressing submit', () => {
    expect(HARNESS_SUBMIT_DELAY_MS).toBe(1000)
  })

  it('submits after the harness has had a chance to start (submit delay shorter than startup delay)', () => {
    expect(HARNESS_SUBMIT_DELAY_MS).toBeLessThan(HARNESS_STARTUP_DELAY_MS)
  })
})
