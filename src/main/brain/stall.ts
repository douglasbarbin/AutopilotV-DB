import type { HarnessConfig } from '@shared/types/domain'

export interface StallSignal {
  isCandidate: boolean
  reason: 'idle' | 'waiting_pattern' | null
  matchedPattern?: string
}

/**
 * Pure stall detection: given a harness config, the seconds since last output,
 * and the recent stdout tail, decide whether the session looks stalled.
 */
export function detectStall(
  harness: HarnessConfig,
  secondsSinceOutput: number,
  tail: string
): StallSignal {
  for (const pat of harness.stall.waitingPatterns) {
    try {
      const re = new RegExp(pat, 'i')
      if (re.test(tail)) return { isCandidate: true, reason: 'waiting_pattern', matchedPattern: pat }
    } catch {
      /* skip invalid pattern */
    }
  }
  if (secondsSinceOutput >= harness.stall.idleSeconds) {
    return { isCandidate: true, reason: 'idle' }
  }
  return { isCandidate: false, reason: null }
}

/**
 * Safety rail: does the proposed injection look destructive per the denylist?
 * Matching is case-insensitive substring against both the tail context and the
 * proposed response (a prompt asking to confirm an rm -rf should not be
 * auto-confirmed).
 */
export function violatesDenylist(
  denylist: string[],
  proposedResponse: string,
  context: string
): string | null {
  const haystack = (proposedResponse + '\n' + context).toLowerCase()
  for (const term of denylist) {
    if (haystack.includes(term.toLowerCase())) return term
  }
  return null
}
