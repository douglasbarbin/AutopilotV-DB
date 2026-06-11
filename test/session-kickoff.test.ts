import { describe, it, expect } from 'vitest'
import {
  isReadyForPrompt,
  judgeEcho,
  promptEchoed,
  isKeyName,
  KICKOFF_MIN_STARTUP_MS,
  KICKOFF_QUIESCENT_MS,
  KICKOFF_MAX_BOOT_WAIT_MS,
  KEY_SEQUENCES
} from '../src/main/sessions/kickoff'
import { quiescenceFingerprint } from '../src/main/util/ansi'

describe('isReadyForPrompt', () => {
  it('never ready before the minimum startup window', () => {
    expect(
      isReadyForPrompt({ buffer: 'ready >', elapsedMs: KICKOFF_MIN_STARTUP_MS - 1, msSinceVisibleChange: 5000 })
    ).toBe(false)
  })

  it('ready when the harness ready-pattern matches the visible text', () => {
    const probe = { buffer: '\x1b[1mWelcome!\x1b[0m\n> ', elapsedMs: 1200, msSinceVisibleChange: 100 }
    expect(isReadyForPrompt(probe, '^> $')).toBe(true)
  })

  it('ready when output has painted and gone visually quiescent', () => {
    expect(
      isReadyForPrompt({ buffer: 'some TUI shell', elapsedMs: 3000, msSinceVisibleChange: KICKOFF_QUIESCENT_MS })
    ).toBe(true)
  })

  it('not ready while the screen is still actively painting', () => {
    expect(isReadyForPrompt({ buffer: 'booting…', elapsedMs: 3000, msSinceVisibleChange: 50 })).toBe(false)
  })

  it('not ready on a blank screen with no output yet', () => {
    expect(isReadyForPrompt({ buffer: '', elapsedMs: 5000, msSinceVisibleChange: null })).toBe(false)
  })

  it('forces readiness at the boot-wait ceiling even on a blank screen', () => {
    expect(
      isReadyForPrompt({ buffer: '', elapsedMs: KICKOFF_MAX_BOOT_WAIT_MS, msSinceVisibleChange: null })
    ).toBe(true)
  })

  it('an invalid ready pattern falls back to generic readiness', () => {
    expect(
      isReadyForPrompt({ buffer: 'shell', elapsedMs: 3000, msSinceVisibleChange: 5000 }, '([broken')
    ).toBe(true)
  })
})

describe('promptEchoed / judgeEcho', () => {
  const prompt = 'Implement LDWF-42: add retry logic to the fetch wrapper and open a draft PR'

  it('detects the echo even when the TUI rewraps the text', () => {
    const buffer = 'banner\n│ Implement LDWF-42: add retry\n│ logic to the fetch wrapper │\n'
    expect(promptEchoed(buffer, prompt)).toBe(true)
  })

  it('detects the echo through ANSI styling', () => {
    const buffer = `\x1b[36mImplement LDWF-42:\x1b[0m add retry logic to the fetch wrapper`
    expect(promptEchoed(buffer, prompt)).toBe(true)
  })

  it('judges retype when nothing at all painted after typing', () => {
    const before = 'welcome screen'
    expect(judgeEcho(before, before, prompt)).toBe('retype')
  })

  it('judges proceed when the screen changed but the prompt is not visible', () => {
    expect(judgeEcho('welcome screen', 'welcome screen\nspinner output', prompt)).toBe('proceed')
  })

  it('judges echoed when the prompt slice is visible', () => {
    expect(judgeEcho('welcome', `welcome\nImplement LDWF-42: add retry logic`, prompt)).toBe('echoed')
  })
})

describe('quiescenceFingerprint', () => {
  it('treats spinner frames and timers as identical', () => {
    const a = '⠋ Working… (3s · 1.2k tokens) esc to interrupt'
    const b = '⠙ Working… (4s · 1.4k tokens) esc to interrupt'
    expect(quiescenceFingerprint(a)).toBe(quiescenceFingerprint(b))
  })

  it('still distinguishes real new output', () => {
    const a = '⠋ Working…'
    const b = '⠋ Working…\nWrote src/foo.ts'
    expect(quiescenceFingerprint(a)).not.toBe(quiescenceFingerprint(b))
  })
})

describe('named keypresses', () => {
  it('maps every key name to a PTY sequence', () => {
    expect(KEY_SEQUENCES.enter).toBe('\r')
    expect(KEY_SEQUENCES.up).toBe('\x1b[A')
    expect(KEY_SEQUENCES.esc).toBe('\x1b')
  })

  it('isKeyName accepts only known names', () => {
    expect(isKeyName('enter')).toBe(true)
    expect(isKeyName('rm -rf')).toBe(false)
  })
})
