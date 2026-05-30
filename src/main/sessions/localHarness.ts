import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { log } from '../log'
import type { LocalModelConfig } from '@shared/types/domain'

/** Provider key AutopilotV manages inside Pi's models.json. */
export const PI_PROVIDER = 'lmstudio'

/** Substitute {model} and {endpoint} placeholders in launch args/env values. */
export function substitute(values: string[], lm?: LocalModelConfig): string[] {
  if (!lm) return values
  return values.map((v) =>
    v.split('{model}').join(lm.name).split('{endpoint}').join(lm.endpoint)
  )
}

/**
 * For a Pi harness backed by a local model, write an isolated config dir with a
 * models.json that defines an OpenAI-compatible provider pointing at the local
 * endpoint (e.g. LM Studio). Returns the env that points Pi at that dir.
 *
 * Using PI_CODING_AGENT_DIR keeps this separate from the user's global ~/.pi
 * config so we never clobber their setup, and guarantees Pi talks to the local
 * endpoint rather than defaulting to a cloud provider.
 */
export function preparePiLocalModel(lm: LocalModelConfig): Record<string, string> {
  const dir = join(app.getPath('userData'), 'pi-agent')
  mkdirSync(dir, { recursive: true })
  const modelsPath = join(dir, 'models.json')

  let doc: { providers?: Record<string, unknown> } = {}
  if (existsSync(modelsPath)) {
    try {
      doc = JSON.parse(readFileSync(modelsPath, 'utf8'))
    } catch {
      doc = {}
    }
  }
  doc.providers = doc.providers ?? {}
  doc.providers[PI_PROVIDER] = {
    baseUrl: `${lm.endpoint}/v1`,
    api: 'openai-completions',
    apiKey: 'local',
    // LM Studio / many OpenAI-compatible servers don't support these.
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [{ id: lm.name }]
  }
  writeFileSync(modelsPath, JSON.stringify(doc, null, 2))
  log.info('wrote Pi models.json', { dir, provider: PI_PROVIDER, model: lm.name, baseUrl: `${lm.endpoint}/v1` })
  return { PI_CODING_AGENT_DIR: dir }
}
