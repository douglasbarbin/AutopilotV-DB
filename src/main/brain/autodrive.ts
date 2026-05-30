import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { detectStall, violatesDenylist } from './stall'
import { tickState } from './tickState'
import { notifier } from '../notify'
import { judgeValidated, StallDecisionSchema, type LlmProvider } from '../llm/provider'
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

  // LLM judgment
  let decision
  try {
    decision = await judgeValidated(
      provider,
      {
        schemaName: 'StallDecision',
        system:
          'You supervise an autonomous coding-agent terminal session. Given the recent terminal output, decide if it is blocked waiting for user input. If so, provide the single safe response that unblocks it (e.g. "y", "1", a short answer). If it needs a human or you are unsure, set escalate=true.',
        user: `Recent terminal output (tail):\n\n${tail}\n\nRespond as JSON: {"waitingForInput":bool,"response":string|null,"escalate":bool,"reason":string}`
      },
      StallDecisionSchema
    )
  } catch (err) {
    log.warn('stall judgment failed; escalating', { sessionId: session.id, err: String(err) })
    escalate(session, 'llm judgment failed')
    return
  }

  if (decision.escalate || !decision.waitingForInput || decision.response == null) {
    if (decision.waitingForInput) escalate(session, decision.reason || 'llm escalated')
    return
  }

  // denylist rail
  const bad = violatesDenylist(settings.autoDrive.destructiveDenylist, decision.response, tail)
  if (bad) {
    store.recordEvent(
      'autodrive.blocked',
      { sessionId: session.id, matched: bad, response: decision.response },
      { level: 'warn', sessionId: session.id }
    )
    escalate(session, `denylist matched: ${bad}`)
    return
  }

  // inject
  sessionManager.inject(session.id, decision.response)
  const count = store.incrementInject(session.id)
  store.setSessionStatus(session.id, 'running')
  store.recordEvent(
    'autodrive.injected',
    {
      sessionId: session.id,
      response: decision.response,
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
    message: `"${session.title}" was waiting — replied "${decision.response}" (${decision.reason}).`,
    detail: { sessionId: session.id, response: decision.response, count }
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
