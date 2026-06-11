import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { detectStall, violatesDenylist, resolveInjection } from './stall'
import { tickState } from './tickState'
import { notifier } from '../notify'
import { judgeValidated, StallDecisionSchema, type LlmProvider, type StallDecision } from '../llm/provider'
import { HARNESS_BOOT_TIMEOUT_SECONDS } from '../sessions/kickoff'
import { normalizeTerminalText, quiescenceFingerprint } from '../util/ansi'
import type { Session, Settings } from '@shared/types/domain'

function secondsSince(iso: string | null): number {
  if (!iso) return Number.MAX_SAFE_INTEGER
  // SQLite datetime('now') is UTC without timezone suffix.
  const t = Date.parse(iso.replace(' ', 'T') + 'Z')
  return Number.isNaN(t) ? 0 : (Date.now() - t) / 1000
}

/**
 * Per-session memory of automated interventions. The fingerprint taken at
 * injection time lets the next tick tell whether the intervention visibly did
 * anything; the history is fed back to the stall LLM so it never answers the
 * same prompt the same way forever.
 */
interface InjectionMemory {
  /** Visible-tail fingerprint at the moment of the last injection, or null. */
  fingerprint: string | null
  /** Consecutive interventions with no visible effect on the terminal. */
  ineffective: number
  history: { kind: string; detail: string; reason: string }[]
}

const injectionMemory = new Map<number, InjectionMemory>()

/** Test hook / lifecycle cleanup. */
export function clearInjectionMemory(sessionId?: number): void {
  if (sessionId == null) injectionMemory.clear()
  else injectionMemory.delete(sessionId)
}

function rememberInjection(sessionId: number, fingerprint: string, kind: string, detail: string, reason: string): void {
  const mem = injectionMemory.get(sessionId) ?? { fingerprint: null, ineffective: 0, history: [] }
  mem.fingerprint = fingerprint
  mem.history.push({ kind, detail, reason })
  if (mem.history.length > 10) mem.history.shift()
  injectionMemory.set(sessionId, mem)
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
  if (!sessionManager.isLive(session.id)) {
    injectionMemory.delete(session.id)
    return
  }
  if (session.status === 'needs_human') return

  const harness = store.getHarness(session.harnessId)
  if (!harness) return

  // Boot watchdog: a session that has NEVER produced output is still booting —
  // judging its empty terminal is meaningless (and secondsSince(null) would
  // otherwise flag it as an instant idle stall). Give it a boot window; if the
  // window closes with the terminal still blank, the harness never started and
  // the session is dead weight — kill it so the owning lane errors visibly.
  if (!session.lastOutputAt) {
    if (secondsSince(session.startedAt) > HARNESS_BOOT_TIMEOUT_SECONDS) {
      log.warn('session produced no output within the boot window; killing', { sessionId: session.id })
      store.recordEvent(
        'session.boot_timeout',
        { sessionId: session.id, timeoutSeconds: HARNESS_BOOT_TIMEOUT_SECONDS },
        { level: 'warn', sessionId: session.id }
      )
      store.recordBrainNote({
        tick: tickState.current,
        category: 'autodrive',
        message: `"${session.title}" never produced any output — the harness likely failed to launch. Killed it.`,
        detail: { sessionId: session.id },
        level: 'warn'
      })
      sessionManager.kill(session.id, 'boot timeout: no output')
      injectionMemory.delete(session.id)
    }
    return
  }

  const tail = sessionManager.getTail(session.id, 8192)
  // Idle is measured on VISIBLE change when available — an animated status bar
  // emits bytes forever, but a session parked at a prompt is visually still.
  const idleSeconds =
    sessionManager.secondsSinceVisibleChange(session.id) ?? secondsSince(session.lastOutputAt)
  const signal = detectStall(harness, idleSeconds, tail)
  const mem = injectionMemory.get(session.id)
  if (!signal.isCandidate) {
    if (session.status === 'stalled') {
      store.setSessionStatus(session.id, 'running')
    }
    // It moved on — whatever we last injected worked. Keep the history for the
    // LLM's context but stop comparing against the stale fingerprint.
    if (mem) {
      mem.fingerprint = null
      mem.ineffective = 0
    }
    return
  }

  store.setSessionStatus(session.id, 'stalled')

  // Post-injection verification: if the terminal looks exactly like it did
  // when we last intervened, that intervention went nowhere. Recovery ladder:
  // one deterministic bare Enter (many TUI modals want a keypress, not text;
  // doesn't burn the injection cap), then hand off to a human rather than
  // burning the rest of the cap on the same stuck screen.
  const fingerprint = quiescenceFingerprint(tail)
  if (mem?.fingerprint && mem.fingerprint === fingerprint) {
    if (mem.ineffective === 0) {
      mem.ineffective = 1
      mem.history.push({ kind: 'keys', detail: 'enter', reason: 'recovery: previous intervention had no visible effect' })
      sessionManager.sendKeys(session.id, ['enter'])
      store.recordEvent(
        'autodrive.retry_enter',
        { sessionId: session.id },
        { level: 'warn', sessionId: session.id }
      )
      store.recordBrainNote({
        tick: tickState.current,
        category: 'autodrive',
        message: `"${session.title}" didn't react to my last intervention — pressed Enter in case the prompt just needed a keypress.`,
        detail: { sessionId: session.id },
        level: 'warn'
      })
      return
    }
    escalate(session, 'automated interventions had no visible effect')
    return
  }
  if (mem) mem.ineffective = 0

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
      : 'No prompt was detected; its visible output has not changed for a while and it may be stuck or idling.'
  const initialInput = sessionManager.getInitialInput(session.id)
  const taskContext = initialInput
    ? `\nThe session was started with this task (truncated):\n${initialInput.slice(0, 400)}\n`
    : ''
  const historyLines =
    mem && mem.history.length > 0
      ? mem.history
          .slice(-3)
          .map((h) => `- ${h.kind}: ${JSON.stringify(h.detail)} (${h.reason})`)
          .join('\n')
      : 'none'
  const visibleTail = normalizeTerminalText(tail).slice(-4000)
  let decision: StallDecision
  try {
    decision = await judgeValidated(
      provider,
      {
        schemaName: 'StallDecision',
        system:
          'You supervise an autonomous coding-agent terminal session that appears stalled. ' +
          'Choose the single best action to keep it productive without a human:\n' +
          '- "respond": it is paused at an interactive prompt that takes text; put the exact, safe text to submit in "response" (e.g. "y", "1", a filename).\n' +
          '- "press_keys": it is paused at a TUI prompt that needs raw keypresses rather than text (a bare Enter to continue, an arrow-key menu); put the key names in "keys", chosen from: enter, up, down, left, right, esc, space, tab.\n' +
          '- "nudge": it has gone quiet without finishing and is NOT at a prompt; put a short message that gets it moving again in "response", or null to use a default nudge.\n' +
          '- "wait": it is still actively working (e.g. a build or progress indicator is advancing); take no action.\n' +
          '- "escalate": it needs a human — an error it cannot resolve itself, a destructive or irreversible decision, genuinely ambiguous requirements, or you are unsure.\n' +
          'Never repeat an intervention that was already tried without visible effect. ' +
          'Prefer keeping the agent moving (respond/press_keys/nudge) over escalating, but never auto-confirm anything destructive.',
        user:
          `${reasonHint}\n${taskContext}\n` +
          `Previous automated interventions this session (most recent last):\n${historyLines}\n\n` +
          `Recent terminal output (visible text, tail):\n\n${visibleTail}\n\n` +
          'Respond as JSON: {"action":"respond"|"press_keys"|"nudge"|"wait"|"escalate","response":string|null,"keys":string[]|null,"reason":string}'
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

  // denylist rail — applies to keypresses and nudges too (an Enter or a nudge
  // into a destructive confirmation would be just as unsafe as typing "y").
  const proposedText = plan.kind === 'keys' ? '' : plan.text
  const bad = violatesDenylist(settings.autoDrive.destructiveDenylist, proposedText, tail)
  if (bad) {
    store.recordEvent(
      'autodrive.blocked',
      { sessionId: session.id, matched: bad, response: planDetail(plan) },
      { level: 'warn', sessionId: session.id }
    )
    escalate(session, `denylist matched: ${bad}`)
    return
  }

  // inject (an answer to a prompt, raw keypresses, or a nudge to unstick)
  if (plan.kind === 'keys') {
    sessionManager.sendKeys(session.id, plan.keys)
  } else {
    sessionManager.inject(session.id, plan.text)
  }
  rememberInjection(session.id, fingerprint, plan.kind, planDetail(plan), decision.reason)
  const count = store.incrementInject(session.id)
  store.setSessionStatus(session.id, 'running')
  store.recordEvent(
    'autodrive.injected',
    {
      sessionId: session.id,
      kind: plan.kind,
      response: planDetail(plan),
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
        : plan.kind === 'keys'
          ? `"${session.title}" was waiting — pressed ${plan.keys.join('+')} (${decision.reason}).`
          : `"${session.title}" was waiting — replied "${plan.text}" (${decision.reason}).`,
    detail: { sessionId: session.id, kind: plan.kind, response: planDetail(plan), count }
  })
}

function planDetail(plan: { kind: string; text?: string; keys?: string[] }): string {
  return plan.kind === 'keys' ? (plan.keys ?? []).join('+') : (plan.text ?? '')
}

function escalate(session: Session, reason: string): void {
  injectionMemory.delete(session.id)
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
