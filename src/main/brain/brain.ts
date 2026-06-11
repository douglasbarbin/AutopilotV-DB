import { EventEmitter } from 'events'
import { existsSync } from 'fs'
import { join } from 'path'
import { log } from '../log'
import * as store from '../store'
import { sessionManager } from '../sessions/manager'
import { autoDriveSession } from './autodrive'
import { harvestReviews, reconcileExternallyResolvedReviews, startReview } from '../review/orchestrator'
import { startDevTask, advanceDevTasks, resetDevTask } from '../dev/orchestrator'
import { gcOrphanedWorktrees } from '../worktree/manager'
import { makeProvider } from '../llm/provider'
import { tickState } from './tickState'
import { ensureLocalModel, pingEndpoint } from '../localmodel/manager'
import { activeForge, type ForgePr } from '../forges'
import { activeTracker } from '../trackers'
import type { IntegrationHealth } from '@shared/types/domain'

const OWNER = `autopilotv-${process.pid}`

export class Brain extends EventEmitter {
  private timer: NodeJS.Timeout | null = null
  private ticking = false
  private running = false
  private lastTickAt: string | null = null

  get state() {
    return {
      lastTickAt: this.lastTickAt,
      ticking: this.ticking,
      running: this.running,
      tick: tickState.current
    }
  }

  /** Emit a human-readable line of reasoning, surfaced in the Brain view. */
  private reason(
    category: 'refresh' | 'schedule' | 'reconcile' | 'autodrive' | 'review' | 'dev' | 'decision',
    message: string,
    detail?: Record<string, unknown>,
    level: 'debug' | 'info' | 'warn' | 'error' = 'info'
  ): void {
    store.recordBrainNote({ tick: tickState.current, category, message, detail, level })
  }

  /** Crash-recovery: run once before the first tick (SPEC §15.4). */
  reconcile(): void {
    // 1. dead PIDs -> killed
    for (const s of store.listActiveSessions()) {
      const alive = s.pid != null && isPidAlive(s.pid)
      if (!alive && !sessionManager.isLive(s.id)) {
        store.setSessionStatus(s.id, 'killed', 'orphaned')
        store.recordEvent('session.orphaned', { sessionId: s.id }, { level: 'warn', sessionId: s.id })
      }
    }
    // 2. expired leases -> unclaimed
    const reset = store.reclaimExpiredLeases()
    if (reset > 0) {
      store.recordEvent('reconcile.leases_reset', { count: reset })
      this.reason('reconcile', `Recovered ${reset} interrupted work item(s) from a previous run — re-queued.`, {
        count: reset
      })
    }
    // 3. orphaned worktrees
    void gcOrphanedWorktrees()
    log.info('reconciliation complete', { leasesReset: reset })
  }

  start(): void {
    if (this.timer) return
    this.running = true
    this.reconcile()
    const loop = () => {
      const interval = store.getSettings().pollIntervalSeconds * 1000
      this.timer = setTimeout(async () => {
        await this.tick()
        if (this.running) loop()
      }, interval)
    }
    // first tick immediately
    void this.tick().then(() => {
      if (this.running) loop()
    })
  }

  stop(): void {
    this.running = false
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }

  setRunning(running: boolean): void {
    if (running) this.start()
    else this.stop()
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    tickState.current += 1
    this.reason('decision', `Tick #${tickState.current} started — checking what work is mine to do.`)
    this.emit('changed')
    try {
      await this.refreshWork()
      await this.reconcileSessions()
      await this.scheduleWork()
      await advanceDevTasks(store.getSettings())
    } catch (err) {
      log.error('tick failed', { err: String(err) })
      store.recordEvent('tick.error', { err: String(err) }, { level: 'error' })
    } finally {
      this.lastTickAt = new Date().toISOString()
      this.ticking = false
      this.emit('changed')
    }
  }

  // ---- step 1: refresh work + health ----
  private async refreshWork(): Promise<void> {
    const settings = store.getSettings()

    // Code forge: review-requested PRs. The active forge (settings.forge)
    // chooses which adapter handles discovery + review submission + merge.
    try {
      const { forge, config: forgeConfig } = activeForge(settings)
      let prs: ForgePr[]
      let detail: string
      const erroredRepos = new Set<string>()
      if (settings.watchRepos.length > 0) {
        const { prs: found, errors } = await forge.listReviewRequestedPrsForRepos(
          settings.watchRepos,
          settings.githubUsername,
          forgeConfig
        )
        prs = found
        detail = `${prs.length} across ${settings.watchRepos.length} repo(s)${
          errors.length ? `, ${errors.length} repo error(s)` : ''
        }`
        for (const e of errors) erroredRepos.add(e.repo)
        if (errors.length) {
          this.reason(
            'refresh',
            `${forge.id}: couldn't read ${errors.map((e) => e.repo).join(', ')} — ${errors[0].error}`,
            { errors },
            'warn'
          )
        }
      } else {
        // No watched repos configured: fall back to the global search filter
        // (only the GitHub adapter supports this today; others return []).
        prs = await forge.listReviewRequestedPrs(settings.githubReviewFilter, forgeConfig)
        detail = `${prs.length} via search filter`
      }
      let reRequested = 0
      const stillRequested = new Set<string>()
      for (const pr of prs) {
        const repo = this.ensureRepo(pr.repoNameWithOwner, forge.id)
        stillRequested.add(`${repo.id}:${pr.number}`)
        const { reRequested: didReRequest } = store.upsertPrReview({
          prNumber: pr.number,
          repoId: repo.id,
          title: pr.title,
          author: pr.author,
          branch: pr.headRefName,
          url: pr.url
        })
        if (didReRequest) {
          reRequested++
          this.reason(
            'refresh',
            `PR #${pr.number} "${pr.title}" was re-requested for review after I'd already reviewed it — re-queued for a fresh pass.`,
            { prNumber: pr.number }
          )
        }
      }

      // Review-lane reconciliation: a queued/in-flight review whose PR merged
      // or closed externally has no branch left to review — supersede it.
      const superseded = await reconcileExternallyResolvedReviews(stillRequested, erroredRepos)
      for (const s of superseded) {
        this.reason(
          'reconcile',
          `PR #${s.prNumber} "${s.title}" was ${s.reason} before my review was used — skipped and cleaned up.`,
          { prNumber: s.prNumber, reason: s.reason }
        )
      }
      this.setHealth({ name: 'forge', status: 'ok', detail: `[${forge.id}] ${detail}` })
      this.reason(
        'refresh',
        `Found ${prs.length} PR(s) awaiting my review on ${forge.id}${reRequested ? ` (${reRequested} re-requested)` : ''}.`,
        { count: prs.length, reRequested, forge: forge.id }
      )
    } catch (err) {
      this.setHealth({ name: 'forge', status: 'down', detail: String(err).slice(0, 120) })
      this.reason('refresh', `forge check failed — ${String(err).slice(0, 100)}`, {}, 'warn')
    }

    // Project tracker: assigned work (epics excluded, disabled projects skipped)
    const { tracker, config } = activeTracker(settings)
    try {
      const issues = await tracker.listAssigned(config)
      let epics = 0
      let kept = 0
      let disabled = 0
      const reopened: { id: number; key: string; status: string }[] = []
      for (const it of issues) {
        store.upsertTrackerProjectSeen(it.projectKey, it.projectName)
        if (it.issueType.toLowerCase() === 'epic') {
          epics++
          continue // defensive: never work an epic even if the query lets one through
        }
        if (!store.isProjectEnabled(it.projectKey)) {
          disabled++
          continue // project toggled off by the user
        }
        kept++
        const { id, reopened: didReopen } = store.upsertTask({
          issueKey: it.key,
          projectKey: it.projectKey,
          title: it.title,
          assignee: it.assignee,
          priority: it.priority,
          issueType: it.issueType,
          sprint: it.sprint,
          status: mapTrackerStatus(it.status),
          trackerStatus: it.status
        })
        if (didReopen) reopened.push({ id, key: it.key, status: it.status })
      }
      store.purgeEpicTasks() // drop any epics previously stored

      // A finished task the tracker has moved back to To Do (e.g. QA bounced it):
      // tear it down to a clean slate so the scheduler can pick it up afresh.
      for (const r of reopened) {
        await resetDevTask(r.id, 'task.reopened')
        this.reason(
          'reconcile',
          `${r.key} was completed but the tracker now shows it back in To Do ("${r.status}") — re-queued for a fresh pickup.`,
          { key: r.key, status: r.status }
        )
      }
      const sprint = issues.find((i) => i.sprint)?.sprint
      this.setHealth({
        name: 'tracker',
        status: 'ok',
        detail: sprint ? `${kept} in ${sprint}` : `${kept} assigned`
      })
      this.reason(
        'refresh',
        `Pulled ${kept} item(s) from ${tracker.id}${sprint ? ` (sprint "${sprint}")` : ''}${
          epics ? `, skipped ${epics} epic(s)` : ''
        }${disabled ? `, ${disabled} in disabled project(s)` : ''}.`,
        { kept, epics, disabled, sprint: sprint ?? null, tracker: tracker.id }
      )
    } catch (err) {
      this.setHealth({ name: 'tracker', status: 'down', detail: String(err).slice(0, 120) })
      this.reason('refresh', `${tracker.id} check failed — ${String(err).slice(0, 100)}`, {}, 'warn')
    }

    // LLM (brain judgment) health
    if (settings.llmProvider === 'harness') {
      const h = store.getBrainHarness()
      if (!h) {
        this.setHealth({ name: 'llm', status: 'down', detail: 'no Brain-default harness set' })
      } else {
        const w = await import('../util/exec').then((m) =>
          m.exec('which', [h.launch.command], { timeoutMs: 5000 })
        )
        this.setHealth({
          name: 'llm',
          status: w.code === 0 ? 'ok' : 'down',
          detail: w.code === 0 ? `harness: ${h.displayName}` : `${h.launch.command} not found`
        })
      }
    } else {
      const ok = await pingEndpoint(settings.localLlmEndpoint)
      this.setHealth({
        name: 'llm',
        status: ok ? 'ok' : 'down',
        detail: ok ? `local: ${settings.llmModel} @ ${settings.localLlmEndpoint}` : `unreachable: ${settings.localLlmEndpoint}`
      })
    }

    // Local model: poll every configured local endpoint to detect if it is
    // already online. This NEVER starts a server — starting is explicit only.
    const endpoints = new Map<string, string>() // endpoint -> model label
    for (const h of store.listHarnesses()) {
      if (h.localModel?.endpoint) endpoints.set(h.localModel.endpoint, h.localModel.name)
    }
    if (settings.llmProvider === 'local') {
      endpoints.set(settings.localLlmEndpoint, endpoints.get(settings.localLlmEndpoint) ?? settings.llmModel)
    }
    if (endpoints.size > 0) {
      const results = await Promise.all(
        [...endpoints.keys()].map(async (ep) => ({ ep, online: await pingEndpoint(ep) }))
      )
      const online = results.filter((r) => r.online)
      this.setHealth({
        name: 'localModel',
        status: online.length > 0 ? 'ok' : 'down',
        detail:
          online.length > 0
            ? `online: ${online.map((r) => endpoints.get(r.ep)).join(', ')}`
            : `offline (${results.length} endpoint${results.length > 1 ? 's' : ''})`
      })
    } else {
      this.setHealth({ name: 'localModel', status: 'unknown', detail: 'no local model configured' })
    }
  }

  // ---- step 2: reconcile live sessions ----
  private async reconcileSessions(): Promise<void> {
    const settings = store.getSettings()
    const provider = makeProvider(settings)

    for (const s of store.listActiveSessions()) {
      // renew lease for the work this session owns
      const [kind, idStr] = s.workRef.split(':')
      if (kind === 'review' || kind === 'dev') {
        store.renewLease(kind, Number(idStr), s.workRef)
      }
      try {
        await autoDriveSession(s, settings, provider)
      } catch (err) {
        log.warn('autodrive error', { sessionId: s.id, err: String(err) })
      }
    }

    await harvestReviews()
  }

  // ---- step 3: schedule new work ----
  private async scheduleWork(): Promise<void> {
    const settings = store.getSettings()
    const active = store.countActiveSessions()
    let slots = settings.maxConcurrentSessions - active

    const reviews = store
      .listPrReviews()
      .filter((p) => p.state === 'discovered' && p.claimState === 'unclaimed')
    const tasks = store
      .listTasks()
      .filter(
        (t) =>
          t.phase === 'unclaimed' &&
          t.status === 'todo' &&
          t.claimState === 'unclaimed' &&
          store.isProjectEnabled(t.projectKey)
      )
    const pending = reviews.length + tasks.length

    if (slots <= 0) {
      if (pending > 0) {
        this.reason(
          'schedule',
          `At capacity (${active}/${settings.maxConcurrentSessions} sessions). ${pending} item(s) waiting for a free slot.`,
          { active, pending }
        )
      }
      return
    }
    if (pending > 0) {
      this.reason(
        'schedule',
        `${slots} free slot(s); ${reviews.length} review(s) and ${tasks.length} task(s) ready to start.`,
        { slots, reviews: reviews.length, tasks: tasks.length }
      )
    }

    // Priority: PR reviews first (cheaper, isolated), then dev tasks.
    for (const pr of reviews) {
      if (slots <= 0) break
      if (!store.claimWork('review', pr.id, OWNER)) continue
      const sid = await startReview(store.getPrReview(pr.id)!)
      if (sid) {
        slots--
        this.reason('review', `Started reviewing PR #${pr.prNumber} "${pr.title}" in a sandboxed worktree.`, {
          prNumber: pr.prNumber
        })
      } else {
        store.releaseLease('review', pr.id)
        this.reason(
          'review',
          `Could not start review of PR #${pr.prNumber} — repo not cloned locally or no review harness.`,
          { prNumber: pr.prNumber },
          'warn'
        )
      }
    }

    for (const task of tasks) {
      if (slots <= 0) break
      if (!store.claimWork('dev', task.id, OWNER)) continue
      const sid = await startDevTask(store.getTask(task.id)!)
      if (sid) {
        slots--
        this.reason('dev', `Claimed ${task.issueKey} "${task.title}" and started implementation.`, {
          key: task.issueKey
        })
      } else {
        store.releaseLease('dev', task.id)
        this.reason('dev', `Could not start ${task.issueKey} — no cloned repo available.`, { key: task.issueKey }, 'warn')
      }
    }
  }

  // ---- helpers ----
  private ensureRepo(nameWithOwner: string, forge = 'github') {
    const existing = store.getRepoByName(nameWithOwner)
    if (existing) {
      if (existing.cloneState !== 'present') this.tryDetectClone(existing.id, nameWithOwner)
      return store.getRepoByName(nameWithOwner)!
    }
    const remote = forge === 'azuredevops'
      ? `https://dev.azure.com/${nameWithOwner.split('/').slice(0, -1).join('/')}/_git/${nameWithOwner.split('/').pop()}`
      : `https://github.com/${nameWithOwner}.git`
    const repo = store.upsertRepo({ name: nameWithOwner, remote, forge })
    this.tryDetectClone(repo.id, nameWithOwner)
    return store.getRepoByName(nameWithOwner)!
  }

  private tryDetectClone(repoId: number, nameWithOwner: string): void {
    const shortName = nameWithOwner.split('/').pop()!
    const candidate = join(store.getSettings().cloneParentDir, shortName)
    if (existsSync(join(candidate, '.git'))) {
      store.setRepoCloneState(repoId, 'present', candidate)
    }
  }

  async ensureLocalModelForReview(): Promise<void> {
    const h = store.getReviewHarness()
    if (h?.localModel) await ensureLocalModel(h.id, h.localModel)
  }

  private setHealth(h: Omit<IntegrationHealth, 'checkedAt'>): void {
    store.setIntegrationHealth({ ...h, checkedAt: new Date().toISOString() })
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function mapTrackerStatus(name: string): 'todo' | 'in_progress' | 'in_review' | 'ready_to_merge' | 'done' {
  const n = name.trim().toLowerCase()
  if (/(done|closed|resolved|complete|cancell)/.test(n)) return 'done'
  if (/review/.test(n)) return 'in_review'
  if (/(progress|doing|in dev|development|implement)/.test(n)) return 'in_progress'
  if (/(to.?do|open|backlog|selected|ready|new|triage)/.test(n)) return 'todo'
  // Unknown status (e.g. Blocked, In QA): not auto-startable, but the raw name is
  // preserved for display. Treat as in_progress so the brain won't auto-claim it.
  return 'in_progress'
}

export const brain = new Brain()
