import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'

/**
 * Git-ignored control files an agent writes in its worktree to signal phase
 * completion. The orchestrator polls for these each tick; consuming one
 * removes it so the next round of the same signal can run.
 *
 * Protocol v2: files are namespaced `.autopilotv-<function>` and carry an
 * optional JSON report (summary, follow-up work items, learned knowledge)
 * alongside the bare completion signal. Parsing is layered so orchestration
 * NEVER depends on the agent writing perfect JSON:
 *   - valid JSON  → full report harvested
 *   - bare URL / empty file (the v1 formats) → lifecycle still advances
 *   - malformed JSON → salvage what's salvageable, flag it, advance anyway
 *
 * Why a typed enum: funnelling every name through this module gives one place
 * to add a new phase signal; a typo'd open-coded name would silently never
 * trigger its transition.
 */
export const SIGNAL = {
  IMPL: '.autopilotv-impl',
  REVISE: '.autopilotv-revise',
  ADDRESS_COMMENTS: '.autopilotv-address-comments'
} as const

export type SignalKind = (typeof SIGNAL)[keyof typeof SIGNAL]

/** v1 filenames, still consumed during the migration window so in-flight
 *  worktrees (and agents prompted before an upgrade) don't strand. */
export const LEGACY_SIGNAL: Record<SignalKind, string> = {
  [SIGNAL.IMPL]: '.pr-url',
  [SIGNAL.REVISE]: '.revise',
  [SIGNAL.ADDRESS_COMMENTS]: '.address-comments'
}

// ---- structured report carried by a v2 signal ----

export const SignalFollowUpSchema = z.object({
  title: z.string().min(1),
  description: z.string().catch(''),
  kind: z.enum(['todo', 'tech_debt', 'bug', 'enhancement', 'test_gap']).catch('todo'),
  priority: z.enum(['low', 'medium', 'high']).catch('medium'),
  files: z.array(z.string()).catch([])
})
export type SignalFollowUp = z.infer<typeof SignalFollowUpSchema>

export const SignalLearningSchema = z.object({
  role: z.enum(['coding', 'review']).catch('coding'),
  insight: z.string().min(1),
  evidence: z.string().catch(''),
  confidence: z.enum(['low', 'medium', 'high']).catch('medium')
})
export type SignalLearning = z.infer<typeof SignalLearningSchema>

export const SignalReportSchema = z.object({
  version: z.number().catch(1),
  prUrl: z.string().optional(),
  summary: z.string().catch(''),
  followUps: z.array(SignalFollowUpSchema).catch([]),
  learnings: z.array(SignalLearningSchema).catch([]),
  deviations: z.string().catch('')
})
export type SignalReport = z.infer<typeof SignalReportSchema>

export interface ConsumedSignal {
  /** Trimmed raw file content ('' for a bare touch). */
  raw: string
  /** Parsed report when the content was (salvageable) JSON, else null. */
  report: SignalReport | null
  /** The content looked like JSON but couldn't be parsed/validated. */
  malformed: boolean
}

/** Layered parse of signal-file content. Never throws. */
export function parseSignalContent(raw: string): ConsumedSignal {
  const text = raw.trim()
  if (!text.startsWith('{')) return { raw: text, report: null, malformed: false } // v1: bare URL or empty
  try {
    return { raw: text, report: SignalReportSchema.parse(JSON.parse(text)), malformed: false }
  } catch {
    return { raw: text, report: null, malformed: true }
  }
}

/**
 * Pull a PR URL out of a consumed IMPL signal: the report field when present,
 * otherwise the first URL-looking token in the raw content — which also
 * salvages the URL from malformed JSON.
 */
export function extractPrUrl(consumed: ConsumedSignal): string | null {
  if (consumed.report?.prUrl) return consumed.report.prUrl.trim()
  const m = consumed.raw.match(/https?:\/\/\S+/)
  if (m) return m[0].replace(/["',}\]]+$/, '')
  return consumed.raw && !consumed.malformed ? consumed.raw.split(/\s+/)[0] : null
}

function signalPath(worktreePath: string, kind: SignalKind): string | null {
  const v2 = join(worktreePath, kind)
  if (existsSync(v2)) return v2
  const v1 = join(worktreePath, LEGACY_SIGNAL[kind])
  return existsSync(v1) ? v1 : null
}

/** True iff a signal file (v2 or legacy v1 name) is present in the worktree. */
export function isSignalled(worktreePath: string, kind: SignalKind): boolean {
  return signalPath(worktreePath, kind) !== null
}

/**
 * Read the contents of a signal file and remove it (so the next round can
 * fire). Returns the trimmed contents, or null if the file isn't there.
 */
export function consume(worktreePath: string, kind: SignalKind): string | null {
  const p = signalPath(worktreePath, kind)
  if (!p) return null
  // Small fixed text content (a JSON report, a PR URL, or an empty `touch`):
  // read synchronously then immediately delete — even malformed content is
  // removed so a bad file can't wedge the phase forever.
  const content = readFileSync(p, 'utf8')
  rmSync(p, { force: true })
  return content.trim()
}

/** Consume + layered parse in one step. Null when no signal file is present. */
export function consumeReport(worktreePath: string, kind: SignalKind): ConsumedSignal | null {
  const raw = consume(worktreePath, kind)
  return raw === null ? null : parseSignalContent(raw)
}

/** Remove a signal file without reading its contents (e.g. cleanup on reset). */
export function clear(worktreePath: string, kind: SignalKind): void {
  rmSync(join(worktreePath, kind), { force: true })
  rmSync(join(worktreePath, LEGACY_SIGNAL[kind]), { force: true })
}

/** All signal names (v2 + legacy), for the worktree's .git/info/exclude setup. */
export const ALL_SIGNALS: string[] = [
  SIGNAL.IMPL,
  SIGNAL.REVISE,
  SIGNAL.ADDRESS_COMMENTS,
  LEGACY_SIGNAL[SIGNAL.IMPL],
  LEGACY_SIGNAL[SIGNAL.REVISE],
  LEGACY_SIGNAL[SIGNAL.ADDRESS_COMMENTS]
]
