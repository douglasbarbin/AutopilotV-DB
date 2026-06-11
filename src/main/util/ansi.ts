/**
 * Terminal text normalization for stall detection and LLM judgment.
 *
 * The PTY ring buffer is raw bytes: ANSI color/cursor sequences, OSC titles,
 * and carriage-return repaints (spinners, progress bars). Regexes like
 * "Press enter" silently fail to match when the phrase is interleaved with
 * escape codes, and a status line that repaints every 100ms looks like fresh
 * output even though nothing visible changed. Normalizing first means both
 * the waiting-pattern regexes and the judgment LLM see what a human sees.
 */

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g
const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const ESC_MISC = /\x1b[@-_]/g

/** Remove ANSI escape sequences (CSI, OSC, two-byte ESC) from terminal text. */
export function stripAnsi(text: string): string {
  return text.replace(OSC, '').replace(CSI, '').replace(ESC_MISC, '')
}

/**
 * Reduce raw terminal output to the visible text: strip ANSI, resolve
 * carriage-return overwrites (only the segment after the last \r on a line is
 * shown), and drop remaining control characters.
 */
export function normalizeTerminalText(text: string): string {
  return stripAnsi(text)
    .split('\n')
    .map((line) => {
      const i = line.lastIndexOf('\r')
      const visible = i === -1 ? line : line.slice(i + 1)
      // eslint-disable-next-line no-control-regex
      return visible.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    })
    .join('\n')
}

/**
 * Reduce terminal output to a stability fingerprint for quiescence detection.
 * Harness TUIs animate even while waiting on input — braille spinners, elapsed
 * timers, token counters — so byte- or even visible-text-level comparison never
 * settles. Dropping spinner glyphs and digits means "the screen is doing
 * nothing but idling animations" compares equal across frames, while any real
 * progress (a new log line, a new prompt) still changes the fingerprint.
 * Detection over-triggering slightly is fine: the stall LLM sees the real tail
 * and can still answer "wait".
 */
export function quiescenceFingerprint(text: string): string {
  return normalizeTerminalText(text)
    .replace(/[⠀-⣿]/g, '') // braille spinner frames
    .replace(/[0-9]/g, '') // timers, token counts, progress percentages
    .replace(/\s+/g, ' ')
    .trim()
}
