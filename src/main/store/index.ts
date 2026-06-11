/**
 * Re-export facade for the per-table store modules.
 *
 * Historically, `src/main/store.ts` was a 917-line god module holding every
 * table's CRUD. It's now split into per-table modules under `store/`:
 *   - settings.ts      — `kv` settings + integration health
 *   - harnesses.ts     — harness adapter config (config_json, role defaults)
 *   - repos.ts         — git repo rows + project→repo resolution
 *   - tasks.ts         — dev-line tasks (issues) and the dev lifecycle
 *   - trackerProjects.ts — per-tracker project enable flags
 *   - reviews.ts       — PR reviews + ReviewSummary rows
 *   - sessions.ts      — node-pty session rows
 *   - worktrees.ts     — git worktree rows
 *   - claim.ts         — atomic claim/lease across tasks + pr_reviews
 *   - events.ts        — append-only event + brain-note log
 *   - migrations_apply.ts — model-defaults migration + boot normalizations
 *
 * The flat `import * as store from '../store'` API used by the rest of the
 * codebase is preserved by re-exporting every symbol from these modules here.
 * New code should prefer importing the per-table module directly.
 */
export {
  getSettings,
  updateSettings,
  getIntegrationHealth,
  setIntegrationHealth,
  kvRead,
  kvWrite
} from './settings'

export { seedIfEmpty, listHarnesses, getHarness, getReviewHarness, getBrainHarness, getCodingHarness, upsertHarness, deleteHarness, normalizeReviewDefault } from './harnesses'

export { listRepos, getRepo, getRepoByName, upsertRepo, setRepoCloneState, setRepoVerifyCommand, setRepoRunbook, resolveProjectRepo } from './repos'

export {
  upsertTask,
  completeTask,
  listTasks,
  getTask,
  purgeEpicTasks,
  setTaskStatus,
  setTaskPhase,
  setTaskPr,
  setTaskRepo,
  setTaskWorktree,
  setTaskVerifiedSha,
  clearVerifiedShaForRepo,
  setTaskAddressed,
  resetTask
} from './tasks'

export { upsertTrackerProjectSeen, listTrackerProjects, setTrackerProjectEnabled, setTrackerProjectRepo, isProjectEnabled } from './trackerProjects'

export {
  upsertPrReview,
  getPrReviewByNumber,
  getPrReview,
  listPrReviews,
  setPrReviewState,
  resetPrReview,
  insertReview,
  listReviews,
  getLatestReviewForPr,
  recordReviewAction
} from './reviews'

export {
  createSession,
  setSessionAutoDrive,
  setSessionPid,
  setSessionStatus,
  markSessionOutput,
  incrementInject,
  getSession,
  listSessions,
  listActiveSessions,
  countActiveSessions
} from './sessions'

export { createWorktree, attachWorktreeSession, getWorktree, listWorktrees, listLiveWorktrees, markWorktreePruned } from './worktrees'

export { claimWork, setClaimState, attachSessionToWork, renewLease, releaseLease, reclaimExpiredLeases } from './claim'

export { recordEvent, listEvents, recordBrainNote, listBrainNotes } from './events'

export { insertVerification, listVerificationsForTask, listRecentVerifications, getPipelineVerdict } from './verifications'

export {
  insertFollowUp,
  listFollowUps,
  getFollowUp,
  updateFollowUp,
  deleteFollowUp,
  setFollowUpStatus,
  insertKnowledge,
  listKnowledge,
  setKnowledgeStatus,
  selectKnowledgeForInjection,
  markKnowledgeApplied,
  insightsTotals
} from './insights'

export * as metrics from './metrics'

export { applyModelDefaults, runStartupNormalizations } from './migrations_apply'
