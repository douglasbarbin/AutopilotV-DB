/**
 * Atomic claim/lease helpers. Work items live in `tasks` (dev) and `pr_reviews`
 * (review); both share the same `claim_state` + `lease_owner` + `lease_expires_at`
 * columns. A `claimWork` is an atomic `UPDATE ... WHERE claim_state='unclaimed'`,
 * guaranteeing at most one brain/process wins.
 */
import { getDb } from './_db'
import type { ClaimState, WorkKind } from '@shared/types/domain'

const LEASE_MINUTES = 15

function tableFor(kind: WorkKind): 'tasks' | 'pr_reviews' {
  return kind === 'review' ? 'pr_reviews' : 'tasks'
}

/** Atomically claim a work item. Returns true if this caller won the claim. */
export function claimWork(kind: WorkKind, id: number, owner: string): boolean {
  const table = tableFor(kind)
  const info = getDb()
    .prepare(
      `UPDATE ${table}
       SET claim_state = 'claimed', lease_owner = ?, lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes'), updated_at = datetime('now')
       WHERE id = ? AND claim_state = 'unclaimed'`
    )
    .run(owner, id)
  return info.changes === 1
}

export function setClaimState(kind: WorkKind, id: number, state: ClaimState): void {
  const table = tableFor(kind)
  getDb()
    .prepare(`UPDATE ${table} SET claim_state = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(state, id)
}

export function attachSessionToWork(kind: WorkKind, id: number, sessionId: number): void {
  const table = tableFor(kind)
  getDb()
    .prepare(`UPDATE ${table} SET session_id = ?, claim_state = 'in_progress' WHERE id = ?`)
    .run(sessionId, id)
}

export function renewLease(kind: WorkKind, id: number, owner: string): void {
  const table = tableFor(kind)
  getDb()
    .prepare(
      `UPDATE ${table} SET lease_expires_at = datetime('now', '+${LEASE_MINUTES} minutes') WHERE id = ? AND lease_owner = ?`
    )
    .run(id, owner)
}

export function releaseLease(kind: WorkKind, id: number): void {
  const table = tableFor(kind)
  getDb()
    .prepare(`UPDATE ${table} SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ?`)
    .run(id)
}

/** Return expired-lease work items to unclaimed. Returns count reset. */
export function reclaimExpiredLeases(): number {
  let total = 0
  for (const table of ['tasks', 'pr_reviews']) {
    const info = getDb()
      .prepare(
        `UPDATE ${table}
         SET claim_state = 'unclaimed', lease_owner = NULL, lease_expires_at = NULL, session_id = NULL
         WHERE claim_state IN ('claimed','in_progress')
           AND lease_expires_at IS NOT NULL
           AND lease_expires_at < datetime('now')`
      )
      .run()
    total += info.changes
  }
  return total
}
