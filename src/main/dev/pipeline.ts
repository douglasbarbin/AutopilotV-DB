import { createHash } from 'crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { app } from 'electron'
import { log } from '../log'
import * as store from '../store'
import { exec, execShell } from '../util/exec'
import { notifier } from '../notify'
import { getSecret, setSecret } from '../secrets'
import {
  resolveRunbook,
  isEmptyRunbook,
  substituteVars,
  type Runbook,
  type RunbookSecretsStep,
  type RunbookStep
} from '../runbook/runbook'
import { appInstances } from '../apps/instances'
import type {
  Repo,
  Settings,
  TaskVerification,
  TrackerTask,
  VerifyCheckpoint,
  Worktree
} from '@shared/types/domain'

/**
 * Staged verification pipeline over the repo's runbook lifecycle slots.
 *
 * Checkpoints:
 *  - 'commit'     → test slot only (cheap, every pushed commit)
 *  - 'draft'      → full pipeline when the PR reaches draft: the change is
 *                   proven RUNNABLE before a human looks at it
 *  - 'merge_gate' → full pipeline before ready_to_merge, skipped when the
 *                   draft checkpoint already proved the same SHA
 *
 * Each stage records one task_verifications row; a synthetic 'pipeline' row
 * rolls up the verdict per (checkpoint, sha). The first gating failure stops
 * the pipeline (app teardown always runs). e2e steps marked advisory are
 * recorded but never gate.
 */

export interface PipelineRun {
  ok: boolean
  ranStages: string[]
  failureSummary?: string
}

interface StageOutcome {
  status: TaskVerification['status']
  summary: string
  detail: Record<string, unknown>
}

function record(
  task: TrackerTask,
  sha: string,
  checkpoint: VerifyCheckpoint,
  kind: TaskVerification['kind'],
  o: StageOutcome
): void {
  store.insertVerification({
    taskId: task.id,
    prNumber: task.prNumber,
    commitSha: sha,
    kind,
    status: o.status,
    summary: o.summary,
    detail: o.detail,
    checkpoint
  })
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex')

// ---- setup stage (cached on declared input files) ----

async function setupInputsHash(worktreePath: string, patterns: string[]): Promise<string | null> {
  // git expands the pathspecs (so globs work anywhere git does) and the hash
  // covers both the file list and contents.
  const ls = await exec('git', ['-C', worktreePath, 'ls-files', '-z', '--', ...patterns])
  if (ls.code !== 0) return null
  const files = ls.stdout.split('\0').filter(Boolean).sort()
  if (files.length === 0) return null
  const h = createHash('sha1')
  for (const f of files) {
    h.update(f)
    try {
      h.update(readFileSync(join(worktreePath, f)))
    } catch {
      /* deleted on branch — name alone contributes */
    }
  }
  return h.digest('hex')
}

async function runSetupStep(
  repo: Repo,
  worktreePath: string,
  step: RunbookStep,
  settings: Settings
): Promise<StageOutcome> {
  const cacheKey = `setupcache:${repo.id}:${sha1(step.run)}`
  let inputs: string | null = null
  if (step.cacheOn.length > 0) {
    inputs = await setupInputsHash(worktreePath, step.cacheOn)
    if (inputs && store.kvRead(cacheKey) === inputs) {
      return { status: 'pass', summary: `\`${step.run}\` skipped — inputs unchanged (cached)`, detail: { cached: true } }
    }
  }
  const r = await execShell(step.run, {
    cwd: worktreePath,
    timeoutMs: (step.timeoutSeconds ?? settings.verifyTimeoutSeconds) * 1000
  })
  if (r.code === 0 && inputs) store.kvWrite(cacheKey, inputs)
  return shellOutcome(step.run, r)
}

function shellOutcome(cmd: string, r: { code: number; stdout: string; stderr: string }): StageOutcome {
  return {
    status: r.code === 0 ? 'pass' : 'fail',
    summary: `\`${cmd}\` → exit ${r.code}`,
    detail: { command: cmd, exitCode: r.code, output: `${r.stdout}\n${r.stderr}`.slice(-4000) }
  }
}

// ---- secrets stage (cached materialization) ----

interface SecretsCacheEntry {
  createdAt: string
  files: Record<string, string> // worktree-relative path → base64 content
}

function secretsCacheKey(repoId: number, step: RunbookSecretsStep): string {
  return `secretscache:${repoId}:${sha1(step.run + '\n' + step.produces.join('\n'))}`
}

async function materializeFiles(worktreePath: string, files: Record<string, string>): Promise<void> {
  const { addToGitExclude } = await import('../worktree/manager')
  for (const [rel, b64] of Object.entries(files)) {
    const p = join(worktreePath, rel)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, Buffer.from(b64, 'base64'))
  }
  await addToGitExclude(worktreePath, Object.keys(files))
}

/**
 * Run one secrets step: serve the produced files from the encrypted cache when
 * fresh; otherwise run the operator's command ONCE (e.g. `op inject`, against
 * the user's unlocked secrets manager), capture the declared outputs, and
 * cache them. Agents and repeat verifications never touch the secrets tool.
 */
async function runSecretsStep(
  repo: Repo,
  worktreePath: string,
  step: RunbookSecretsStep,
  settings: Settings
): Promise<StageOutcome> {
  const key = secretsCacheKey(repo.id, step)
  const cachedRaw = await getSecret(key)
  if (cachedRaw && step.produces.length > 0) {
    try {
      const cached = JSON.parse(cachedRaw) as SecretsCacheEntry
      const ageH = (Date.now() - Date.parse(cached.createdAt)) / 3_600_000
      if (ageH < step.cacheTtlHours) {
        await materializeFiles(worktreePath, cached.files)
        return {
          status: 'pass',
          summary: `materialized ${Object.keys(cached.files).length} file(s) from secrets cache (age ${ageH.toFixed(1)}h)`,
          detail: { cached: true, files: Object.keys(cached.files) }
        }
      }
    } catch {
      /* unreadable cache → fall through to a fresh run */
    }
  }

  const r = await execShell(step.run, {
    cwd: worktreePath,
    timeoutMs: (step.timeoutSeconds ?? 120) * 1000
  })
  if (r.code !== 0) {
    return {
      status: 'error',
      summary: `secrets step failed (exit ${r.code}) — is your secrets manager unlocked?`,
      // Output deliberately truncated hard: secrets-tool errors can echo fragments.
      detail: { command: step.run, exitCode: r.code, output: `${r.stderr || r.stdout}`.slice(-500) }
    }
  }

  const files: Record<string, string> = {}
  const missing: string[] = []
  for (const rel of step.produces) {
    const p = join(worktreePath, rel)
    if (existsSync(p)) files[rel] = readFileSync(p).toString('base64')
    else missing.push(rel)
  }
  if (missing.length > 0) {
    return {
      status: 'error',
      summary: `secrets step ran but did not produce: ${missing.join(', ')}`,
      detail: { command: step.run, missing }
    }
  }
  if (step.produces.length > 0) {
    await setSecret(key, JSON.stringify({ createdAt: new Date().toISOString(), files } satisfies SecretsCacheEntry))
    const { addToGitExclude } = await import('../worktree/manager')
    await addToGitExclude(worktreePath, step.produces)
  }
  void settings
  return {
    status: 'pass',
    summary: `secrets materialized fresh (${step.produces.length} file(s) cached for ${step.cacheTtlHours}h)`,
    detail: { files: step.produces }
  }
}

/** Drop a repo's cached secrets (Settings → Refresh secrets). */
export async function clearSecretsCache(repoId: number): Promise<number> {
  const { listSecretKeys, deleteSecret } = await import('../secrets')
  const keys = await listSecretKeys(`secretscache:${repoId}:`)
  for (const k of keys) await deleteSecret(k)
  return keys.length
}

// ---- artifacts ----

function collectArtifacts(task: TrackerTask, checkpoint: VerifyCheckpoint, worktreePath: string, rels: string[]): string[] {
  const out: string[] = []
  for (const rel of rels) {
    const src = join(worktreePath, rel)
    if (!existsSync(src)) continue
    const dest = join(app.getPath('userData'), 'artifacts', `task-${task.id}`, checkpoint, basename(rel))
    try {
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, { recursive: true })
      out.push(dest)
    } catch (err) {
      log.warn('artifact copy failed', { src, err: String(err) })
    }
  }
  return out
}

// ---- the pipeline ----

export async function runPipeline(
  task: TrackerTask,
  repo: Repo,
  worktree: Worktree,
  settings: Settings,
  checkpoint: VerifyCheckpoint,
  sha: string
): Promise<PipelineRun> {
  const resolved = resolveRunbook(repo)
  const rb: Runbook = resolved.runbook
  if (resolved.error) {
    record(task, sha, checkpoint, 'pipeline', {
      status: 'error',
      summary: `Runbook yaml is invalid — fix it in Settings or ${repo.name}'s RUNBOOK.md`,
      detail: { error: resolved.error, source: resolved.source }
    })
    return { ok: true, ranStages: [] } // never block on a broken runbook; surface it instead
  }
  if (isEmptyRunbook(rb)) {
    return { ok: true, ranStages: [] } // nothing declared — legacy path handles it
  }

  const ran: string[] = []
  let failure: { stage: string; summary: string; output: string } | null = null

  const runSimpleSlot = async (kind: 'setup' | 'build' | 'test', steps: RunbookStep[]): Promise<boolean> => {
    for (const step of steps) {
      const o =
        kind === 'setup'
          ? await runSetupStep(repo, worktree.path, step, settings)
          : shellOutcome(
              step.run,
              await execShell(step.run, {
                cwd: worktree.path,
                timeoutMs: (step.timeoutSeconds ?? settings.verifyTimeoutSeconds) * 1000
              })
            )
      record(task, sha, checkpoint, kind, o)
      ran.push(kind)
      if (o.status === 'fail' || o.status === 'error') {
        failure = { stage: kind, summary: o.summary, output: String(o.detail.output ?? '') }
        return false
      }
    }
    return true
  }

  const full = checkpoint !== 'commit'
  const stagesOk = await (async (): Promise<boolean> => {
    if (full && !(await runSimpleSlot('setup', rb.setup))) return false
    if (full) {
      for (const step of rb.secrets) {
        const o = await runSecretsStep(repo, worktree.path, step, settings)
        record(task, sha, checkpoint, 'secrets', o)
        ran.push('secrets')
        if (o.status === 'error' || o.status === 'fail') {
          failure = { stage: 'secrets', summary: o.summary, output: '' }
          notifier.notify({
            kind: 'needs_human',
            title: `Secrets needed — ${repo.name}`,
            body: o.summary,
            deepLink: { type: 'task', id: task.id }
          })
          return false
        }
      }
      if (!(await runSimpleSlot('build', rb.build))) return false
    }
    if (!(await runSimpleSlot('test', rb.test))) return false

    // app + e2e: only at full checkpoints, only when the runbook declares an app.
    if (full && rb.app) {
      const start = await appInstances.start(repo, worktree.path, rb.app, task.id)
      record(task, sha, checkpoint, 'app', {
        status: start.ok ? 'pass' : 'fail',
        summary: start.summary,
        detail: { ports: start.instance?.ports ?? {}, log: start.logTail.slice(-3000) }
      })
      ran.push('app')
      if (!start.ok || !start.instance) {
        failure = { stage: 'app', summary: start.summary, output: start.logTail }
        return false
      }
      try {
        const vars = {
          ports: appInstances.portsOf(start.instance.id),
          instance: start.instance.id,
          worktree: worktree.path
        }
        for (const step of rb.e2e) {
          const cmd = substituteVars(step.run, vars)
          const r = await execShell(cmd, {
            cwd: worktree.path,
            timeoutMs: (step.timeoutSeconds ?? settings.verifyTimeoutSeconds) * 1000
          })
          const artifacts = collectArtifacts(task, checkpoint, worktree.path, step.artifacts)
          const o = shellOutcome(cmd, r)
          o.detail.artifacts = artifacts
          o.detail.gate = step.gate
          record(task, sha, checkpoint, 'e2e', o)
          ran.push('e2e')
          if (o.status === 'fail' && step.gate === 'blocking') {
            failure = { stage: 'e2e', summary: o.summary, output: String(o.detail.output ?? '') }
            return false
          }
        }
      } finally {
        await appInstances.stop(start.instance.id, 'pipeline complete')
      }
    }
    return true
  })()

  record(task, sha, checkpoint, 'pipeline', {
    status: stagesOk ? 'pass' : 'fail',
    summary: stagesOk
      ? `pipeline passed at ${checkpoint} (${[...new Set(ran)].join(' → ') || 'no stages'})`
      : `pipeline failed at ${checkpoint}: ${failure!.stage} — ${failure!.summary}`,
    detail: { stages: ran, source: resolved.source }
  })

  if (!stagesOk) {
    store.recordEvent(
      'dev.verify_failed',
      { taskId: task.id, prNumber: task.prNumber, sha, checkpoint, stage: failure!.stage },
      { level: 'warn' }
    )
    return {
      ok: false,
      ranStages: ran,
      failureSummary: `[${failure!.stage}] ${failure!.summary}\n\n${failure!.output.slice(-2000)}`
    }
  }
  return { ok: true, ranStages: ran }
}

/** True when the runbook resolves to declared stages (pipeline path active). */
export function hasRunbookStages(repo: Repo): boolean {
  const resolved = resolveRunbook(repo)
  return !resolved.error && !isEmptyRunbook(resolved.runbook) && resolved.source !== 'legacy'
}
