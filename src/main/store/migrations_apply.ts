import { log } from '../log'
import { kvRead, kvWrite, updateSettings } from './settings'
import { getHarness, upsertHarness, normalizeReviewDefault } from './harnesses'
import { purgeEpicTasks } from './tasks'

/**
 * One-time application of the model defaults (brain → gemma, local coding → qwen)
 * to an already-seeded install. Idempotent via a kv flag, and only patches
 * persisted settings if the user already has a saved settings row.
 */
export function applyModelDefaults(): void {
  if (kvRead('model_defaults') === 'v7') return

  // Ensure Claude runs in auto permission mode.
  const claude = getHarness('claude')
  if (claude) {
    claude.launch = { ...claude.launch, args: ['--permission-mode', 'auto'] }
    upsertHarness(claude)
  }

  const coder = getHarness('pi')
  if (coder) {
    coder.displayName = 'Pi · Qwen3 Coder'
    coder.launch = { ...coder.launch, command: 'pi', args: [] }
    coder.localModel = {
      ...(coder.localModel ?? { name: '', endpoint: '' }),
      name: 'qwen/qwen3-coder-30b',
      endpoint: 'http://127.0.0.1:1234'
    }
    upsertHarness(coder)
  }

  // Only touch persisted settings if a saved row exists; otherwise DEFAULT_SETTINGS
  // (now local/gemma) already applies live.
  if (kvRead('settings')) {
    updateSettings({
      llmProvider: 'local',
      llmModel: 'gemma-4-e4b-it-mlx',
      localLlmEndpoint: 'http://127.0.0.1:1234'
    })
  }

  kvWrite('model_defaults', 'v7')
  log.info('applied model defaults: brain=gemma-4-e4b-it-mlx, coding=qwen/qwen3-coder-30b')
}

/** Boot-time normalization: drop epics that slipped into the task list, and
 *  repair any drift in the review-default role flag. */
export function runStartupNormalizations(): void {
  normalizeReviewDefault()
  purgeEpicTasks()
}
