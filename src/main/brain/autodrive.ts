import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { detectStall, violatesDenylist, resolveInjection } from './stall'
import { tickState } from './tickState'
import { notifier } from '../notify'
import { judgeValidated, StallDecisionSchema, type LlmProvider, type StallDecision } from '../llm/provider'
import type { Session, Settings } from '@shared/types/domain'

function secondsSince(iso: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER
  // SQLite datetime('now') is UTC without timezone suffix.
  const t = Date.parse(iso.replace(' ', 'T') + 'Z')
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 1000
}

/**
 * Auto-drive a single session. LLM-first per SPEC §8: every stall candidate is
 * sent to the LLM for judgment; a denylist rail blocks destructive injections;
 * an injection cap forces escalation.
 */
export async function autoDriveSession(
  session: Session,
  settings: Settings,
  provider: LlmProvider
): Promise<void> {
  if (!session.autoDrive) return // per-session toggle
  if (!sessionManager.isLive(session.id)) return
  if (session.status === 'needs_human') return

  const harness = store.getHarness(session.harnessId)
  if (!harness) return

  const tail = sessionManager.getTail(session.id)
  const signal = detectStall(harness, secondsSince(session.lastOutputAt), tail)
  if (!signal.isCandidate) {
    if (session.status === 'stalled') {
      store.setSessionStatus(session.id, 'running')
    }
    return
  }

  store.setSessionStatus(session.id, 'stalled')

  // injection cap
  if (session.autoInjectCount >= settings.autoDrive.maxInjectionsPerSession) {
    escalate(session, 'injection cap reached')
    return
  }

  // LLM judgment. The hint biases the model toward the likely action: a matched
  // prompt pattern usually wants an answer; a silent idle session usually wants a
  // nudge to get moving again (or a human if it's truly stuck).
  const reasonHint =
    signal.reason === 'waiting_pattern'
      ? `A prompt pattern matched (${signal.matchedPattern}); it is most likely paused for input.`
      : 'No prompt was detected; it has produced no output for a while and may be stuck or idling.'
  let decision: StallDecision
  try {
    decision = await judgeValidated(
      provider,
      {
        schemaName: 'StallDecision',
        system:
          'You supervise an autonomous coding-agent terminal session that appears stalled. ' +
          'Choose the single best action to keep it productive without a human:\n' +
          '- "respond": it is paused at an interactive prompt; put the exact, safe text to submit in "response" (e.g. "y", "1", a filename).\n' +
          '- "nudge": it has gone quiet without finishing and is NOT at a prompt; put a short message that gets it moving again in "response", or null to use a default nudge.\n' +
          '- "wait": it is still actively working (e.g. a build or progress indicator is advancing); take no action.\n' +
          '- "escalate": it needs a human — an error it cannot resolve itself, a destructive or irreversible decision, genuinely ambiguous requirements, or you are unsure.\n' +
          'Prefer keeping the agent moving (respond/nudge) over escalating, but never auto-confirm anything destructive.',
        user: `${reasonHint}\n\nRecent terminal output (tail):\n\n${tail}\n\nRespond as JSON: {"action":"respond"|"nudge"|"wait"|"escalate","response":string|null,"reason":string}`
      },
      StallDecisionSchema
    )
  } catch (err) {
    log.warn('stall judgment failed; escalating', { sessionId: session.id, err: String(err) })
    escalate(session, 'llm judgment failed')
    return
  }

  const plan = resolveInjection(decision)
  if (plan.kind === 'escalate') {
    escalate(session, decision.reason || 'llm escalated')
    return
  }
  if (plan.kind === 'wait') {
    // Still making progress per the model — leave it stalled and re-check next
    // tick. We deliberately don't inject, so this can't burn the injection cap.
    store.recordEvent(
      'autodrive.waiting',
      { sessionId: session.id, reason: decision.reason },
      { sessionId: session.id }
    )
    return
  }

  // denylist rail — applies to nudges too (a nudge into a destructive prompt
  // would be just as unsafe as confirming it).
  const bad = violatesDenylist(settings.autoDrive.destructiveDenylist, plan.text, tail)
  if (bad) {
    store.recordEvent(
      'autodrive.blocked',
      { sessionId: session.id, matched: bad, response: plan.text },
      { level: 'warn', sessionId: session.id }
    )
    escalate(session, `denylist matched: ${bad}`)
    return
  }

  // inject (an answer to a prompt, or a nudge to unstick a quiet session)
  sessionManager.inject(session.id, plan.text)
  const count = store.incrementInject(session.id)
  store.setSessionStatus(session.id, 'running')
  store.recordEvent(
    'autodrive.injected',
    {
      sessionId: session.id,
      kind: plan.kind,
      response: plan.text,
      reason: decision.reason,
      via: 'llm',
      count,
      matchedPattern: signal.matchedPattern
    },
    { sessionId: session.id }
  )
  store.recordBrainNote({
    tick: tickState.current,
    category: 'autodrive',
    message:
      plan.kind === 'nudge'
        ? `"${session.title}" went quiet — nudged it to keep going (${decision.reason}).`
        : `"${session.title}" was waiting — replied "${plan.text}" (${decision.reason}).`,
    detail: { sessionId: session.id, kind: plan.kind, response: plan.text, count }
  })
}

function escalate(session: Session, reason: string): void {
  store.setSessionStatus(session.id, 'needs_human', reason)
  store.recordEvent('autodrive.escalated', { sessionId: session.id, reason }, { level: 'warn', sessionId: session.id })
  store.recordBrainNote({
    tick: tickState.current,
    category: 'autodrive',
    message: `"${session.title}" needs a human — ${reason}.`,
    detail: { sessionId: session.id },
    level: 'warn'
  })
  notifier.notify({
    kind: 'needs_human',
    title: `Session needs you — ${session.title}`,
    body: reason,
    deepLink: { type: 'session', id: session.id }
  })
}
