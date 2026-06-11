import { z } from 'zod'
import type { LlmProviderKind, Settings } from '@shared/types/domain'
import { exec } from '../util/exec'
import { getHarness, getBrainHarness } from '../store'
import { substitute, preparePiLocalModel } from '../sessions/localHarness'
import { log } from '../log'

// ---- Structured judgment schemas ----

export const StallDecisionSchema = z.object({
  // respond: answer an interactive prompt with text. press_keys: the prompt
  // needs raw keypresses (Enter to continue, arrow-key menus) rather than
  // text. nudge: the agent went quiet without finishing and isn't at a prompt
  // — push it to keep going. wait: it's still making progress, leave it alone.
  // escalate: hand off to a human.
  //
  // Only `action` is strict. Small local models routinely omit the metadata
  // fields, and a missing "reason" must not invalidate an otherwise usable
  // decision (it did — twice in a row — and escalated a healthy session).
  action: z.enum(['respond', 'press_keys', 'nudge', 'wait', 'escalate']),
  response: z.string().nullable().catch(null),
  keys: z.array(z.string()).nullable().optional().catch(null),
  reason: z.string().catch('')
})
export type StallDecision = z.infer<typeof StallDecisionSchema>

export const ReviewResultSchema = z.object({
  recommendation: z.enum(['approve', 'request_changes', 'comment']),
  summary: z.string(),
  findings: z.array(
    z.object({
      severity: z.enum(['info', 'minor', 'major', 'blocker']),
      file: z.string(),
      line: z.number().optional(),
      note: z.string()
    })
  )
})
export type ReviewResult = z.infer<typeof ReviewResultSchema>

// Advisory diff-vs-ticket check (theme B). Does the change plausibly implement
// what the ticket asked for? Surfaced to the human; never blocks promotion.
export const SpecConformanceSchema = z.object({
  conforms: z.boolean(),
  confidence: z.enum(['low', 'medium', 'high']),
  concerns: z.array(z.string()),
  summary: z.string()
})
export type SpecConformance = z.infer<typeof SpecConformanceSchema>

export interface JudgeRequest {
  system: string
  user: string
  schemaName: string
}

export interface LlmProvider {
  kind: LlmProviderKind
  judge(req: JudgeRequest): Promise<unknown>
}

class LocalProvider implements LlmProvider {
  kind: LlmProviderKind = 'local'
  constructor(
    private model: string,
    private endpoint: string
  ) {}

  async judge(req: JudgeRequest): Promise<unknown> {
    const { default: OpenAI } = await import('openai')
    const client = new OpenAI({ baseURL: `${this.endpoint}/v1`, apiKey: 'local' })
    const resp = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: req.system + '\n\nRespond with ONLY a single valid JSON object.' },
        { role: 'user', content: req.user }
      ],
      temperature: 0.2
    })
    return extractJson(resp.choices[0]?.message?.content ?? '')
  }
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = fenced ? fenced[1] : text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1) throw new Error('no JSON object in LLM response')
  return JSON.parse(candidate.slice(start, end + 1))
}

/**
 * Drives ANY configured harness in headless mode (`-p <prompt>`) for brain
 * judgment. Most harnesses (claude, pi, codex, opencode, …) accept `-p` for a
 * non-interactive run; we resolve {model}/{endpoint} placeholders, add local-model
 * env (and Pi's models.json) when the harness is local-backed, and extract JSON.
 */
class HarnessProvider implements LlmProvider {
  kind: LlmProviderKind = 'harness'
  constructor(private harnessId: string) {}

  async judge(req: JudgeRequest): Promise<unknown> {
    const h = getHarness(this.harnessId)
    if (!h) throw new Error(`brain harness '${this.harnessId}' not found`)
    const lm = h.localModel
    let args = substitute(h.launch.args, lm)
    if (h.launch.command === 'claude') {
      if (!args.includes('--permission-mode')) args = ['--permission-mode', 'auto', ...args]
      if (!args.includes('--output-format')) args = [...args, '--output-format', 'text']
    }
    const prompt = `${req.system}\n\n${req.user}\n\nRespond with ONLY a single valid JSON object, no prose.`
    args = [...args, '-p', prompt]

    let env: NodeJS.ProcessEnv = { ...process.env }
    if (lm) {
      env = {
        ...env,
        OPENAI_BASE_URL: `${lm.endpoint}/v1`,
        OPENAI_API_BASE: `${lm.endpoint}/v1`,
        OPENAI_API_KEY: 'local',
        OPENAI_MODEL: lm.name
      }
      if (h.launch.command === 'pi') env = { ...env, ...preparePiLocalModel(lm) }
    }

    const r = await exec(h.launch.command, args, { timeoutMs: 120_000, env })
    if (r.code !== 0) {
      throw new Error(`brain harness ${h.id} failed (${r.code}): ${(r.stderr || r.stdout).slice(0, 200)}`)
    }
    return extractJson(r.stdout)
  }
}

export function makeProvider(settings: Settings): LlmProvider {
  if (settings.llmProvider === 'local') {
    return new LocalProvider(settings.llmModel, settings.localLlmEndpoint)
  }
  // 'harness' — use whichever harness is flagged Brain default (Claude included).
  return new HarnessProvider(getBrainHarness()?.id ?? '')
}

/**
 * Run a judgment with one retry on schema-validation failure. Throws on hard
 * failure so callers can degrade to "escalate".
 */
export async function judgeValidated<T>(
  provider: LlmProvider,
  req: JudgeRequest,
  // Input widened to unknown so schemas using .catch()/.default() (whose input
  // type differs from their output type) are accepted.
  schema: z.ZodType<T, z.ZodTypeDef, unknown>
): Promise<T> {
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await provider.judge(req)
      return schema.parse(raw)
    } catch (err) {
      lastErr = err
      log.warn('llm judgment attempt failed', { attempt, schemaName: req.schemaName })
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('llm judgment failed')
}
