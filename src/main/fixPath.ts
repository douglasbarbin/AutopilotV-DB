import { execFileSync } from 'child_process'
import { log } from './log'

/**
 * GUI apps on macOS (and many Linux desktops) launch with a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), so CLIs installed via Homebrew, npm/nvm, etc.
 * aren't found. Resolve the user's real PATH from their login shell and merge it
 * into process.env.PATH so `exec()` and spawned PTY sessions can find the tools.
 */
export function fixPath(): void {
  if (process.platform === 'win32') return

  const home = process.env.HOME ?? ''
  const fallback = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    home && `${home}/.local/bin`,
    home && `${home}/bin`
  ].filter(Boolean) as string[]

  let shellPath = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // -ilc → interactive login shell so rc files (nvm, etc.) populate PATH.
    shellPath = execFileSync(shell, ['-ilc', 'printf %s "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    // Shell query failed (unusual rc, fish, timeout) — fall back to common dirs.
  }

  const seen = new Set<string>()
  const merged: string[] = []
  for (const p of [...shellPath.split(':'), ...(process.env.PATH ?? '').split(':'), ...fallback]) {
    if (p && !seen.has(p)) {
      seen.add(p)
      merged.push(p)
    }
  }
  process.env.PATH = merged.join(':')
  log.info('resolved PATH', { entries: merged.length, fromShell: shellPath.length > 0 })
}
