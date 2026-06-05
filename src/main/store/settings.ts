/**
 * Settings + opaque key/value pairs. Settings are a single row in `kv` under
 * the key `settings`; everything else in `kv` is integration-health JSON, the
 * `model_defaults` migration marker, and the `onboarded` flag.
 */
import { getDb } from './_db'
import { DEFAULT_SETTINGS } from '../config/defaults'
import type { IntegrationHealth, Settings } from '@shared/types/domain'

function kvGet(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function kvSet(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value)
}

export function getSettings(): Settings {
  const raw = kvGet('settings')
  if (!raw) return DEFAULT_SETTINGS
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  kvSet('settings', JSON.stringify(next))
  return next
}

export function getIntegrationHealth(): IntegrationHealth[] {
  const raw = kvGet('integration_health')
  if (!raw) return []
  try {
    return JSON.parse(raw) as IntegrationHealth[]
  } catch {
    return []
  }
}

export function setIntegrationHealth(h: IntegrationHealth): void {
  const all = getIntegrationHealth()
  const next = all.filter((x) => x.name !== h.name).concat(h)
  kvSet('integration_health', JSON.stringify(next))
}

/** Generic read for any kv key — used by tests and a few specific call sites. */
export function kvRead(key: string): string | null {
  return kvGet(key)
}

/** Generic write for any kv key. */
export function kvWrite(key: string, value: string): void {
  kvSet(key, value)
}
