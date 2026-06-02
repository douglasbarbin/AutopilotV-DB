/**
 * xterm.js ITheme palettes keyed by AutopilotV theme ID.
 *
 * Each palette covers:
 *   - background / foreground / cursor / cursorAccent
 *   - selectionBackground / selectionForeground
 *   - Full ANSI 16-color set (normal + bright)
 *
 * Colors are taken directly from the CSS custom-property definitions in
 * styles.css so the terminal matches the app chrome exactly. Bright variants
 * follow the canonical base16 / terminal-theme conventions for the respective
 * color scheme where the CSS doesn't define them explicitly.
 *
 * The terminal itself supports 24-bit truecolor and 256-color natively —
 * the PTY is spawned with TERM=xterm-256color and COLORTERM=truecolor so
 * any tool that queries the terminal capabilities (bat, delta, lazygit,
 * rich, etc.) will render full color output without any extra configuration.
 */

import type { ITheme } from '@xterm/xterm'

// ---------------------------------------------------------------------------
// Tomorrow Night Eighties (default)
// ---------------------------------------------------------------------------
const tomorrowNight80s: ITheme = {
  background: '#2d2d2d',
  foreground: '#cccccc',
  cursor: '#cccccc',
  cursorAccent: '#2d2d2d',
  selectionBackground: '#515151',
  selectionForeground: '#f2f2f2',

  black: '#2d2d2d',
  red: '#f2777a',
  green: '#99cc99',
  yellow: '#ffcc66',
  blue: '#6699cc',
  magenta: '#cc99cc',
  cyan: '#66cccc',
  white: '#d3d0c8',

  brightBlack: '#747369',
  brightRed: '#f2777a',
  brightGreen: '#99cc99',
  brightYellow: '#ffcc66',
  brightBlue: '#6699cc',
  brightMagenta: '#cc99cc',
  brightCyan: '#66cccc',
  brightWhite: '#f2f0ec'
}

// ---------------------------------------------------------------------------
// Tomorrow (light)
// ---------------------------------------------------------------------------
const tomorrow: ITheme = {
  background: '#ffffff',
  foreground: '#4d4d4c',
  cursor: '#4d4d4c',
  cursorAccent: '#ffffff',
  selectionBackground: '#d6d6d6',
  selectionForeground: '#1d1f21',

  black: '#1d1f21',
  red: '#c82829',
  green: '#5c8a00',
  yellow: '#c9a000',
  blue: '#4271ae',
  magenta: '#8959a8',
  cyan: '#3e999f',
  white: '#c5c8c6',

  brightBlack: '#969896',
  brightRed: '#cc6666',
  brightGreen: '#b5bd68',
  brightYellow: '#f0c674',
  brightBlue: '#81a2be',
  brightMagenta: '#b294bb',
  brightCyan: '#8abeb7',
  brightWhite: '#ffffff'
}

// ---------------------------------------------------------------------------
// Synthwave / Outrun
// ---------------------------------------------------------------------------
const synthwave: ITheme = {
  background: '#241b2f',
  foreground: '#f0e6ff',
  cursor: '#ff7edb',
  cursorAccent: '#241b2f',
  selectionBackground: '#4a3a6a',
  selectionForeground: '#ffffff',

  black: '#1c1428',
  red: '#fe4450',
  green: '#72f1b8',
  yellow: '#fede5d',
  blue: '#6ea8fe',
  magenta: '#c792ea',
  cyan: '#36f9f6',
  white: '#a08ec0',

  brightBlack: '#392a52',
  brightRed: '#fe4450',
  brightGreen: '#72f1b8',
  brightYellow: '#fede5d',
  brightBlue: '#6ea8fe',
  brightMagenta: '#ff7edb',
  brightCyan: '#36f9f6',
  brightWhite: '#f0e6ff'
}

// ---------------------------------------------------------------------------
// Tokyo Night
// ---------------------------------------------------------------------------
const tokyoNight: ITheme = {
  background: '#1a1b26',
  foreground: '#a9b1d6',
  cursor: '#c0caf5',
  cursorAccent: '#1a1b26',
  selectionBackground: '#33467c',
  selectionForeground: '#c0caf5',

  black: '#15161e',
  red: '#f7768e',
  green: '#9ece6a',
  yellow: '#e0af68',
  blue: '#7aa2f7',
  magenta: '#bb9af7',
  cyan: '#7dcfff',
  white: '#a9b1d6',

  brightBlack: '#414868',
  brightRed: '#f7768e',
  brightGreen: '#9ece6a',
  brightYellow: '#e0af68',
  brightBlue: '#7aa2f7',
  brightMagenta: '#bb9af7',
  brightCyan: '#7dcfff',
  brightWhite: '#c0caf5'
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const THEMES: Record<string, ITheme> = {
  'tomorrow-night-80s': tomorrowNight80s,
  tomorrow: tomorrow,
  synthwave: synthwave,
  'tokyo-night': tokyoNight
}

/**
 * Return the xterm ITheme for the given AutopilotV theme ID.
 * Falls back to Tomorrow Night Eighties for any unknown value.
 */
export function getTerminalTheme(themeId: string): ITheme {
  return THEMES[themeId] ?? tomorrowNight80s
}
