import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'

/**
 * Git-ignored control files an agent writes in its worktree to signal phase
 * completion. The orchestrator polls for these each tick; consuming one
 * removes it so the next round of the same signal can run.
 *
 * Why a typed enum: the previous implementation open-coded the names in two
 * places (dev/orchestrator + worktree/manager), with prompt strings
 * re-interpolating them. New signals would have to be added in two files; a
 * typo in one would silently never trigger the transition. Funnelling
 * everything through this module gives one place to add a new phase signal.
 */
export const SIGNAL = {
  PR_URL: '.pr-url',
  REVISE: '.revise',
  ADDRESS_COMMENTS: '.address-comments'
} as const

export type SignalKind = (typeof SIGNAL)[keyof typeof SIGNAL]

/** True iff a signal file is present in the worktree. */
export function isSignalled(worktreePath: string, kind: SignalKind): boolean {
  return existsSync(join(worktreePath, kind))
}

/**
 * Read the contents of a signal file and remove it (so the next round can
 * fire). Returns the trimmed contents, or null if the file isn't there.
 */
export function consume(worktreePath: string, kind: SignalKind): string | null {
  const p = join(worktreePath, kind)
  if (!existsSync(p)) return null
  // We rely on small fixed text content (a PR URL or empty `touch`), so read
  // synchronously then immediately delete. The agent's `touch` arrives as ''
  // which is still a valid signal — we just discard the empty string.
  const content = readFileSync(p, 'utf8')
  rmSync(p, { force: true })
  return content.trim()
}

/** Remove a signal file without reading its contents (e.g. cleanup on reset). */
export function clear(worktreePath: string, kind: SignalKind): void {
  rmSync(join(worktreePath, kind), { force: true })
}

/** All signal names, in the order they're checked. Used by the worktree's
 *  .git/info/exclude setup. */
export const ALL_SIGNALS: SignalKind[] = [
  SIGNAL.PR_URL,
  SIGNAL.REVISE,
  SIGNAL.ADDRESS_COMMENTS
]
