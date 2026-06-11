/**
 * Closed-loop session kickoff logic.
 *
 * The old kickoff was open-loop: type the prompt at T+2s, press Enter at T+3s,
 * hope the harness was listening. If the TUI took longer to boot, the task
 * prompt landed on a black screen and the session sat idle forever. These pure
 * helpers drive the feedback version in SessionManager.kickoff: wait until the
 * harness looks ready, type, verify the prompt echoed back, then submit.
 *
 * Kept Electron-free so tests can exercise the decisions without PTYs.
 */
import { normalizeTerminalText, quiescenceFingerprint } from '../util/ansi'

/** Poll cadence for the kickoff feedback loops. */
export const KICKOFF_POLL_MS = 250
/** Never type into a harness younger than this, ready-looking or not. */
export const KICKOFF_MIN_STARTUP_MS = 1000
/** Visible output stable this long ⇒ the TUI has finished painting its shell. */
export const KICKOFF_QUIESCENT_MS = 1500
/** Readiness ceiling: past this we type anyway rather than wait forever. */
export const KICKOFF_MAX_BOOT_WAIT_MS = 30_000
/** How long to wait for the typed prompt to echo back before moving on. */
export const KICKOFF_ECHO_TIMEOUT_MS = 6000
/** Grace after typing before "no echo at all" is allowed to trigger a retype. */
export const KICKOFF_ECHO_GRACE_MS = 1500
/** Small settle between confirming the echo and pressing submit. */
export const KICKOFF_SUBMIT_SETTLE_MS = 200

/**
 * A live session that has produced NO output this long after starting never
 * booted (crashed binary, login wall on a black screen, hung launcher). The
 * watchdog kills it so the owning lane can surface an error instead of the
 * session sitting "running" forever.
 */
export const HARNESS_BOOT_TIMEOUT_SECONDS = 180

export interface ReadinessProbe {
  /** Raw ring-buffer contents right now. */
  buffer: string
  /** Milliseconds since the PTY was spawned. */
  elapsedMs: number
  /** Milliseconds since the visible fingerprint last changed, or null if no output yet. */
  msSinceVisibleChange: number | null
}

/**
 * Is the harness ready to receive the task prompt? Per-harness ready pattern
 * wins when configured; otherwise generic readiness is "it painted something
 * and the screen has been visually still for a beat". The boot-wait ceiling
 * forces progress either way — typing late beats never typing.
 */
export function isReadyForPrompt(probe: ReadinessProbe, readyPattern?: string): boolean {
  if (probe.elapsedMs < KICKOFF_MIN_STARTUP_MS) return false
  const visible = normalizeTerminalText(probe.buffer)
  if (readyPattern) {
    try {
      // Multiline: prompt patterns are naturally line-anchored ("^> $").
      if (new RegExp(readyPattern, 'im').test(visible)) return true
    } catch {
      /* invalid pattern — fall through to generic readiness */
    }
  }
  if (
    visible.trim().length > 0 &&
    probe.msSinceVisibleChange != null &&
    probe.msSinceVisibleChange >= KICKOFF_QUIESCENT_MS
  ) {
    return true
  }
  return probe.elapsedMs >= KICKOFF_MAX_BOOT_WAIT_MS
}

// Box-drawing characters are stripped too: TUIs wrap echoed input inside
// bordered boxes, so "│" lands mid-text at every visual line break.
const collapse = (s: string): string =>
  normalizeTerminalText(s)
    .replace(/[─-╿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Did the typed prompt echo back in the terminal? TUIs rewrap the echoed text
 * at terminal width and may draw box borders, so we look for a short leading
 * slice of the prompt (whitespace-collapsed on both sides) that fits within
 * one rendered line rather than the full text.
 */
export function promptEchoed(buffer: string, prompt: string): boolean {
  const needle = collapse(prompt).slice(0, 32).trim()
  if (!needle) return true
  return collapse(buffer).includes(needle)
}

export type EchoVerdict = 'echoed' | 'retype' | 'proceed'

/**
 * Judge the echo state after typing the prompt. 'retype' only when the screen
 * shows nothing new at all since we typed — the keystrokes went nowhere
 * (harness not accepting input yet). If the screen changed but the prompt text
 * isn't visible, the harness probably renders input its own way; retyping
 * would risk submitting the prompt twice, so we proceed.
 */
export function judgeEcho(bufferBeforeTyping: string, bufferNow: string, prompt: string): EchoVerdict {
  if (promptEchoed(bufferNow, prompt)) return 'echoed'
  return collapse(bufferNow) === collapse(bufferBeforeTyping) ? 'retype' : 'proceed'
}

// ---- named keypresses ----
// Auto-drive can press raw keys (arrow-key menus, bare Enter continues) in
// addition to typing text. Names are what the stall LLM emits; sequences are
// what the PTY receives.

export const KEY_NAMES = ['enter', 'up', 'down', 'left', 'right', 'esc', 'space', 'tab'] as const
export type KeyName = (typeof KEY_NAMES)[number]

export const KEY_SEQUENCES: Record<KeyName, string> = {
  enter: '\r',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  esc: '\x1b',
  space: ' ',
  tab: '\t'
}

export function isKeyName(k: string): k is KeyName {
  return (KEY_NAMES as readonly string[]).includes(k)
}

export { quiescenceFingerprint }
