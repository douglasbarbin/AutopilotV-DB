import { z } from 'zod'
import { parse as parseYaml } from 'yaml'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Repo } from '@shared/types/domain'

/**
 * Runbook: per-repo "init to runnable" as data, keeping AutopilotV
 * project-agnostic. A RUNBOOK.md holds a plain-English narrative for agents
 * plus ONE fenced ```yaml block of lifecycle slots the orchestrator executes
 * deterministically. Every slot is optional, every command is operator-defined
 * shell — AutopilotV supplies the slots, substitution variables, caching,
 * readiness waiting, and evidence collection; it has no opinion about what
 * runs inside them.
 *
 * Resolution order (resolveRunbook):
 *   1. operator override stored on the repo row (Settings UI)
 *   2. RUNBOOK.md committed in the repo's TRUNK clone — deliberately not the
 *      task worktree, so a branch under test cannot weaken its own
 *      verification; runbook changes take effect after they merge
 *   3. legacy repos.verify_command as a single test step
 */

const StepSchema = z.preprocess(
  (s) => (typeof s === 'string' ? { run: s } : s),
  z.object({
    run: z.string().min(1),
    timeoutSeconds: z.number().positive().optional(),
    /** setup only: git pathspecs whose content hash keys the setup cache. */
    cacheOn: z.array(z.string()).catch([])
  })
)
export type RunbookStep = z.infer<typeof StepSchema>

const SecretsStepSchema = z.preprocess(
  (s) => (typeof s === 'string' ? { run: s } : s),
  z.object({
    run: z.string().min(1),
    /** Worktree-relative files the command materializes; these are cached. */
    produces: z.array(z.string()).catch([]),
    cacheTtlHours: z.number().positive().catch(12),
    timeoutSeconds: z.number().positive().optional()
  })
)
export type RunbookSecretsStep = z.infer<typeof SecretsStepSchema>

const ReadySchema = z.object({
  url: z.string().optional(),
  logPattern: z.string().optional(),
  timeoutSeconds: z.number().positive().catch(300)
})

const AppSchema = z.object({
  run: z.string().min(1),
  env: z.record(z.string()).catch({}),
  /** Named ports. 'auto' opts into AutopilotV allocation (and concurrent
   *  instances); a fixed number or an empty map means the project owns its
   *  ports and runs exclusively. */
  ports: z.record(z.union([z.literal('auto'), z.number()])).catch({}),
  /** True when `run` is a LAUNCHER that exits after starting the real app
   *  (e.g. `aspire start`, `docker compose up -d`). A clean launcher exit is
   *  then not an app death, and `teardown` is the only way to stop the app. */
  detached: z.boolean().catch(false),
  ready: ReadySchema.optional(),
  teardown: z.string().optional(),
  timeoutSeconds: z.number().positive().catch(600)
})
export type RunbookApp = z.infer<typeof AppSchema>

const E2eStepSchema = z.preprocess(
  (s) => (typeof s === 'string' ? { run: s } : s),
  z.object({
    run: z.string().min(1),
    /** Worktree-relative artifact dirs/files copied out as evidence. */
    artifacts: z.array(z.string()).catch([]),
    gate: z.enum(['blocking', 'advisory']).catch('advisory'),
    timeoutSeconds: z.number().positive().optional()
  })
)
export type RunbookE2eStep = z.infer<typeof E2eStepSchema>

export const RunbookSchema = z.object({
  version: z.number().catch(1),
  setup: z.array(StepSchema).catch([]),
  secrets: z.array(SecretsStepSchema).catch([]),
  build: z.array(StepSchema).catch([]),
  test: z.array(StepSchema).catch([]),
  app: AppSchema.optional(),
  e2e: z.array(E2eStepSchema).catch([])
})
export type Runbook = z.infer<typeof RunbookSchema>

export const RUNBOOK_FILENAME = 'RUNBOOK.md'

export function emptyRunbook(): Runbook {
  return { version: 1, setup: [], secrets: [], build: [], test: [], app: undefined, e2e: [] }
}

export function isEmptyRunbook(r: Runbook): boolean {
  return (
    r.setup.length === 0 &&
    r.secrets.length === 0 &&
    r.build.length === 0 &&
    r.test.length === 0 &&
    !r.app &&
    r.e2e.length === 0
  )
}

/**
 * Parse a RUNBOOK.md document: extract the first fenced yaml block and
 * validate it. A document without a yaml block is pure narrative (valid, no
 * steps); a malformed yaml block reports the error but never throws.
 */
export function parseRunbookDoc(text: string): { runbook: Runbook | null; error?: string } {
  const m = text.match(/```ya?ml\s*\n([\s\S]*?)```/)
  if (!m) return { runbook: null }
  try {
    const data: unknown = parseYaml(m[1])
    return { runbook: RunbookSchema.parse(data ?? {}) }
  } catch (err) {
    return { runbook: null, error: String(err).slice(0, 400) }
  }
}

export interface ResolvedRunbook {
  runbook: Runbook
  /** Full markdown text — the narrative agents read. '' when legacy/none. */
  narrative: string
  source: 'override' | 'repo' | 'legacy' | 'none'
  /** Parse error of the yaml block, if any (steps fall back, narrative kept). */
  error?: string
}

function legacyRunbook(repo: Repo): Runbook | null {
  const cmd = repo.verifyCommand?.trim()
  if (!cmd) return null
  const rb = emptyRunbook()
  rb.test = [{ run: cmd, cacheOn: [] }]
  return rb
}

export function resolveRunbook(repo: Repo): ResolvedRunbook {
  const fallback = legacyRunbook(repo)

  const override = (repo.runbook ?? '').trim()
  if (override) {
    const { runbook, error } = parseRunbookDoc(override)
    return { runbook: runbook ?? fallback ?? emptyRunbook(), narrative: override, source: 'override', error }
  }

  if (repo.path) {
    const p = join(repo.path, RUNBOOK_FILENAME)
    if (existsSync(p)) {
      try {
        const text = readFileSync(p, 'utf8')
        const { runbook, error } = parseRunbookDoc(text)
        return { runbook: runbook ?? fallback ?? emptyRunbook(), narrative: text, source: 'repo', error }
      } catch {
        /* unreadable file — fall through */
      }
    }
  }

  if (fallback) return { runbook: fallback, narrative: '', source: 'legacy' }
  return { runbook: emptyRunbook(), narrative: '', source: 'none' }
}

/**
 * Substitute the orchestrator-provided variables into a runbook command/url:
 * {port:name} (allocated or fixed ports), {instance} (unique per running
 * instance — safe for container/compose project names), {worktree} (absolute
 * worktree path). Unknown placeholders are left intact.
 */
export function substituteVars(
  text: string,
  vars: { ports?: Record<string, number>; instance?: string; worktree?: string }
): string {
  let out = text
  for (const [name, port] of Object.entries(vars.ports ?? {})) {
    out = out.split(`{port:${name}}`).join(String(port))
  }
  if (vars.instance) out = out.split('{instance}').join(vars.instance)
  if (vars.worktree) out = out.split('{worktree}').join(vars.worktree)
  return out
}
