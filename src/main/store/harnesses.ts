import { getDb } from './_db'
import { log } from '../log'
import { SEED_HARNESSES } from '../config/defaults'
import type { HarnessConfig } from '@shared/types/domain'

interface HarnessRow {
  id: string
  display_name: string
  config_json: string
  enabled: number
}

/** Clear a role-default flag on every harness in a single transaction. The
 *  config_json column is the sole source of truth for role defaults — we
 *  read every row, flip the flag in JS, and write them all back. */
function clearRoleDefault(flag: 'isReviewDefault' | 'isBrainDefault' | 'isCodingDefault'): void {
  const db = getDb()
  const rows = db.prepare('SELECT id, config_json FROM harnesses').all() as HarnessRow[]
  if (rows.length === 0) return
  const update = db.prepare('UPDATE harnesses SET config_json = ? WHERE id = ?')
  const tx = db.transaction(() => {
    for (const r of rows) {
      const cfg = JSON.parse(r.config_json) as HarnessConfig
      if (!cfg[flag]) continue
      const next: HarnessConfig = { ...cfg, [flag]: false }
      update.run(JSON.stringify(next), r.id)
    }
  })
  tx()
}

export function listHarnesses(): HarnessConfig[] {
  const rows = getDb()
    .prepare('SELECT * FROM harnesses ORDER BY display_name')
    .all() as HarnessRow[]
  return rows.map((r) => JSON.parse(r.config_json) as HarnessConfig)
}

export function getHarness(id: string): HarnessConfig | null {
  const row = getDb()
    .prepare('SELECT config_json FROM harnesses WHERE id = ?')
    .get(id) as { config_json: string } | undefined
  return row ? (JSON.parse(row.config_json) as HarnessConfig) : null
}

export function getReviewHarness(): HarnessConfig | null {
  return listHarnesses().find((h) => h.isReviewDefault && h.enabled) ?? null
}

export function getBrainHarness(): HarnessConfig | null {
  return listHarnesses().find((h) => h.isBrainDefault && h.enabled) ?? null
}

export function getCodingHarness(): HarnessConfig | null {
  return (
    listHarnesses().find((h) => h.isCodingDefault && h.enabled) ??
    listHarnesses().find((h) => h.enabled) ??
    null
  )
}

export function upsertHarness(cfg: HarnessConfig): void {
  // Enforce a single default per role across all harnesses.
  if (cfg.isReviewDefault) clearRoleDefault('isReviewDefault')
  if (cfg.isBrainDefault) clearRoleDefault('isBrainDefault')
  if (cfg.isCodingDefault) clearRoleDefault('isCodingDefault')
  getDb()
    .prepare(
      `INSERT INTO harnesses (id, display_name, config_json, enabled)
       VALUES (@id, @display_name, @config_json, @enabled)
       ON CONFLICT(id) DO UPDATE SET
         display_name = @display_name, config_json = @config_json,
         enabled = @enabled`
    )
    .run({
      id: cfg.id,
      display_name: cfg.displayName,
      config_json: JSON.stringify(cfg),
      enabled: cfg.enabled ? 1 : 0
    })
}

export function deleteHarness(id: string): void {
  getDb().prepare('DELETE FROM harnesses WHERE id = ?').run(id)
}

/** Repair a DB that ended up with multiple review defaults — keep exactly one. */
export function normalizeReviewDefault(): void {
  const defaults = listHarnesses().filter((h) => h.isReviewDefault)
  if (defaults.length > 1) {
    // upsertHarness clears the flag on every other harness.
    upsertHarness({ ...defaults[0], isReviewDefault: true })
    log.warn('normalized review default', { kept: defaults[0].id, cleared: defaults.length - 1 })
  }
}

export function seedIfEmpty(): void {
  const count = (getDb().prepare('SELECT COUNT(*) AS c FROM harnesses').get() as { c: number }).c
  if (count > 0) return
  log.info('seeding default harnesses')
  for (const h of SEED_HARNESSES) upsertHarness(h)
}
