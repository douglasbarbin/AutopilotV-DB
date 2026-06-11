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
