import type { HarnessConfig } from '@shared/types/domain'
import type { StallDecision } from '../llm/provider'
import { normalizeTerminalText } from '../util/ansi'
import { isKeyName, type KeyName } from '../sessions/kickoff'

export interface StallSignal {
  isCandidate: boolean
  reason: 'idle' | 'waiting_pattern' | null
  matchedPattern?: string
}

/**
 * Pure stall detection: given a harness config, the seconds since last output,
 * and the recent stdout tail, decide whether the session looks stalled.
 * Patterns are matched against the ANSI-stripped visible text — a "Press enter"
 * broken up by color codes or repainted over a spinner line still matches.
 */
export function detectStall(
  harness: HarnessConfig,
  secondsSinceOutput: number,
  tail: string
): StallSignal {
  const visible = normalizeTerminalText(tail)
  for (const pat of harness.stall.waitingPatterns) {
    try {
      const re = new RegExp(pat, 'i')
      if (re.test(visible)) return { isCandidate: true, reason: 'waiting_pattern', matchedPattern: pat }
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

/**
 * Fallback nudge for a session that has gone quiet without finishing and isn't
 * sitting at a recognizable prompt — used when the LLM picks `nudge` but doesn't
 * supply its own wording.
 */
export const DEFAULT_NUDGE =
  "You've gone quiet without finishing. If you were waiting on me, take this as a " +
  'go-ahead and continue with the next step. If the task is actually complete, say ' +
  'so explicitly and stop.'

export type InjectionPlan =
  | { kind: 'respond' | 'nudge'; text: string }
  | { kind: 'keys'; keys: KeyName[] }
  | { kind: 'wait' }
  | { kind: 'escalate' }

/**
 * Pure mapping from a validated LLM stall decision to a concrete autodrive
 * action. Kept here with the other pure stall logic so the branching is
 * unit-testable without a live session.
 */
export function resolveInjection(decision: StallDecision): InjectionPlan {
  switch (decision.action) {
    case 'respond':
      // A prompt answer with nothing to send is not actionable — hand off.
      return decision.response ? { kind: 'respond', text: decision.response } : { kind: 'escalate' }
    case 'press_keys': {
      const keys = (decision.keys ?? []).map((k) => k.trim().toLowerCase()).filter(isKeyName)
      // Unknown key names are dropped rather than guessed; nothing left ⇒ hand off.
      return keys.length > 0 ? { kind: 'keys', keys } : { kind: 'escalate' }
    }
    case 'nudge':
      return { kind: 'nudge', text: decision.response?.trim() || DEFAULT_NUDGE }
    case 'wait':
      return { kind: 'wait' }
    default:
      return { kind: 'escalate' }
  }
}
