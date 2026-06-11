import { z } from 'zod'
import { log } from '../log'
import * as store from '../store'
import { judgeValidated, makeProvider } from '../llm/provider'
import type { KnowledgeItem, Settings } from '@shared/types/domain'

/**
 * Periodic knowledge consolidation: the learning loop only stays useful if the
 * knowledge base stays small and sharp. This pass (per repo+role group):
 *
 *  1. LLM curation (best-effort, one call per sizable group): merge duplicate
 *     insights into a single better-worded item and retire stale/generic ones.
 *  2. Deterministic cap: regardless of the LLM, never keep more than
 *     ACTIVE_CAP active items per group — beyond that the injected AGENTS.md
 *     section becomes noise that degrades sessions instead of helping them.
 *     Overflow retires lowest-confidence, least-recently-applied first.
 *
 * Runs at most once per CONSOLIDATION_INTERVAL via maybeConsolidateKnowledge,
 * called from the brain tick.
 */

export const ACTIVE_CAP = 15
const MIN_GROUP_FOR_LLM = 5
const CONSOLIDATION_INTERVAL_MS = 24 * 60 * 60 * 1000
const KV_LAST_RUN = 'knowledge.lastConsolidatedAt'

const ConsolidationSchema = z.object({
  // ids to retire outright (stale, generic, contradicted)
  retire: z.array(z.number()).catch([]),
  // groups of duplicate ids to merge into one rewritten insight
  merges: z
    .array(
      z.object({
        ids: z.array(z.number()),
        insight: z.string().min(1),
        confidence: z.enum(['low', 'medium', 'high']).catch('medium')
      })
    )
    .catch([])
})

export async function maybeConsolidateKnowledge(settings: Settings): Promise<void> {
  const last = store.kvRead(KV_LAST_RUN)
  if (last && Date.now() - Date.parse(last) < CONSOLIDATION_INTERVAL_MS) return
  store.kvWrite(KV_LAST_RUN, new Date().toISOString())
  try {
    await consolidateKnowledge(settings)
  } catch (err) {
    log.warn('knowledge consolidation failed', { err: String(err) })
  }
}

const CONF_RANK: Record<string, number> = { high: 2, medium: 1, low: 0 }

function groupKey(k: KnowledgeItem): string {
  return `${k.scope}:${k.repoId ?? 'g'}:${k.role}`
}

export async function consolidateKnowledge(
  settings: Settings
): Promise<{ retired: number; merged: number }> {
  const live = store.listKnowledge().filter((k) => k.status !== 'retired')
  const groups = new Map<string, KnowledgeItem[]>()
  for (const k of live) {
    const key = groupKey(k)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(k)
  }

  let retired = 0
  let merged = 0

  for (const items of groups.values()) {
    // 1. LLM curation for groups big enough to be worth a judgment call.
    if (items.length >= MIN_GROUP_FOR_LLM) {
      try {
        const provider = makeProvider(settings)
        const listing = items
          .map(
            (k) =>
              `id=${k.id} [${k.status}, ${k.confidence}, used ${k.hitCount}x] ${k.insight}`
          )
          .join('\n')
        const result = await judgeValidated<z.infer<typeof ConsolidationSchema>>(
          provider,
          {
            schemaName: 'KnowledgeConsolidation',
            system:
              'You curate a small knowledge base of repo-specific conventions injected into coding agents. ' +
              'Identify (a) ids to RETIRE: generic advice any competent agent already knows, items contradicted by others, or stale items; ' +
              '(b) MERGES: groups of ids that say the same thing — rewrite them as one crisp insight. ' +
              'Be conservative: when unsure, keep an item. Never merge unrelated insights.',
            user:
              `Knowledge items:\n${listing}\n\n` +
              'Respond as JSON: {"retire": number[], "merges": [{"ids": number[], "insight": string, "confidence": "low"|"medium"|"high"}]}'
          },
          ConsolidationSchema
        )
        const valid = new Set(items.map((k) => k.id))
        for (const m of result.merges) {
          const ids = m.ids.filter((id) => valid.has(id))
          if (ids.length < 2) continue
          const members = items.filter((k) => ids.includes(k.id))
          const anyActive = members.some((k) => k.status === 'active')
          const proto = members[0]
          store.insertKnowledge({
            scope: proto.scope,
            repoId: proto.repoId,
            projectKey: proto.projectKey,
            role: proto.role,
            insight: m.insight,
            evidence: members.map((k) => k.evidence).filter(Boolean).join('; ').slice(0, 300),
            confidence: m.confidence,
            status: anyActive ? 'active' : 'candidate',
            source: 'consolidation'
          })
          for (const id of ids) {
            store.setKnowledgeStatus(id, 'retired')
            retired++
          }
          merged++
        }
        for (const id of result.retire) {
          if (!valid.has(id)) continue
          // Skip anything that was already retired as part of a merge.
          const cur = store.listKnowledge().find((k) => k.id === id)
          if (cur && cur.status !== 'retired') {
            store.setKnowledgeStatus(id, 'retired')
            retired++
          }
        }
      } catch (err) {
        log.warn('knowledge curation LLM pass failed; applying cap only', { err: String(err) })
      }
    }

    // 2. Deterministic cap on the ACTIVE set (re-read: the LLM pass above may
    //    have changed statuses in this group).
    const key = groupKey(items[0])
    const activeNow = store.listKnowledge('active').filter((k) => groupKey(k) === key)
    if (activeNow.length > ACTIVE_CAP) {
      const keepOrder = [...activeNow].sort((a, b) => {
        const conf = (CONF_RANK[b.confidence] ?? 0) - (CONF_RANK[a.confidence] ?? 0)
        if (conf !== 0) return conf
        return (b.lastAppliedAt ?? b.updatedAt).localeCompare(a.lastAppliedAt ?? a.updatedAt)
      })
      for (const k of keepOrder.slice(ACTIVE_CAP)) {
        store.setKnowledgeStatus(k.id, 'retired')
        retired++
      }
    }
  }

  if (retired > 0 || merged > 0) {
    store.recordEvent('knowledge.consolidated', { retired, merged })
  }
  return { retired, merged }
}
