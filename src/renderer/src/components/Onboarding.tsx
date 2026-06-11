import { useEffect, useState } from 'react'
import type { AppState, Settings } from '@shared/types/domain'
import type { EnvItem } from '@shared/types/ipc'
import { TRACKERS, trackerDescriptor } from '@shared/types/trackers'
import { FORGES, forgeDescriptor } from '@shared/types/forges'
import { api } from '../api'

/**
 * First-run walkthrough. Design rules:
 *  - the step rail is labeled and clickable (revisit anything already seen);
 *  - every step says WHY it matters in one line before asking for anything;
 *  - role defaults are radios (one per role — the UI now matches the backend
 *    invariant instead of looking like independent checkboxes);
 *  - the final step is a LIVE readiness checklist derived from real state,
 *    not a static congratulation.
 */
const STEPS = ['Welcome', 'Environment', 'Forge', 'Tracker', 'Brain', 'Agents', 'Launch'] as const

export function Onboarding({ state }: { state: AppState }) {
  const s = state.settings
  const [step, setStep] = useState(0)
  const [visited, setVisited] = useState(1)
  const patch = (p: Partial<Settings>) => void api.updateSettings(p)

  const go = (i: number) => {
    const clamped = Math.max(0, Math.min(i, STEPS.length - 1))
    setStep(clamped)
    setVisited((v) => Math.max(v, clamped + 1))
  }
  const finish = () => {
    void api.updateSettings({ onboarded: true })
    void api.setBrainRunning(true)
  }

  return (
    <div className="onboard-overlay">
      <div className="onboard-card">
        <div className="onboard-head">
          <div className="onboard-logo">
            <strong>AutopilotV</strong>
            <span>setup</span>
          </div>
          <div className="onboard-steps">
            {STEPS.map((label, i) => (
              <button
                key={label}
                className={`onboard-step-pill ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                disabled={i >= visited}
                onClick={() => go(i)}
              >
                <span className="onboard-dot-mini">{i < step ? '✓' : i + 1}</span>
                <span className="onboard-step-label">{label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="onboard-body">
          {step === 0 && <Welcome />}
          {step === 1 && <EnvStep />}
          {step === 2 && <ForgeStep s={s} patch={patch} />}
          {step === 3 && <TrackerStep s={s} patch={patch} />}
          {step === 4 && <BrainStep s={s} patch={patch} />}
          {step === 5 && <HarnessStep state={state} />}
          {step === 6 && <LaunchStep state={state} />}
        </div>

        <div className="onboard-foot">
          <div className="onboard-foot-left">
            <button className="btn-ghost" onClick={() => void api.updateSettings({ onboarded: true })}>
              Skip setup
            </button>
            <span className="onboard-progress muted">
              Step {step + 1} of {STEPS.length}
            </span>
          </div>
          <div className="onboard-nav">
            {step > 0 && (
              <button className="btn-ghost" onClick={() => go(step - 1)}>
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button className="btn-primary" onClick={() => go(step + 1)}>
                {step === 0 ? "Let's set up" : 'Next'}
              </button>
            ) : (
              <button className="btn-primary" onClick={finish}>
                Start the brain 🚀
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Welcome() {
  return (
    <div className="onboard-step">
      <h2>Your work, on autopilot</h2>
      <p>
        AutopilotV finds the work that&apos;s yours — PRs awaiting your review and tasks assigned to
        you — and drives it through coding agents in real terminals. You stay in the loop for the
        decisions that matter: approving reviews and merging PRs.
      </p>
      <div className="onboard-tiles">
        <div className="onboard-tile">
          <span className="onboard-tile-icon">🔭</span>
          <strong>Reviews, prepared</strong>
          <span>PRs are reviewed in sandboxed worktrees; you approve with one click.</span>
        </div>
        <div className="onboard-tile">
          <span className="onboard-tile-icon">🛠️</span>
          <strong>Tasks, shipped</strong>
          <span>Claim → implement → draft PR → review rounds → ready for your merge.</span>
        </div>
        <div className="onboard-tile">
          <span className="onboard-tile-icon">✅</span>
          <strong>Changes, proven</strong>
          <span>Per-repo runbooks build, run, and e2e-test every change before you look.</span>
        </div>
        <div className="onboard-tile">
          <span className="onboard-tile-icon">🧠</span>
          <strong>Knowledge, kept</strong>
          <span>Merged work becomes backlog candidates and learned conventions.</span>
        </div>
      </div>
      <p className="muted">
        Recommended kit: <strong>git</strong>, a forge CLI (<code>gh</code> or Azure DevOps), your
        tracker&apos;s CLI, and at least one coding agent (Claude Code recommended; Pi, Codex,
        Cursor, OpenCode also work).
      </p>
    </div>
  )
}

function EnvStep() {
  const [env, setEnv] = useState<EnvItem[] | null>(null)
  const [loading, setLoading] = useState(false)
  const run = () => {
    setLoading(true)
    void api.checkEnv().then((r) => {
      setEnv(r)
      setLoading(false)
    })
  }
  useEffect(run, [])

  const icon = (it: EnvItem) => (!it.present ? '✗' : it.authed === false ? '!' : '✓')
  const cls = (it: EnvItem) =>
    !it.present ? (it.role === 'optional' ? 'warn' : 'bad') : it.authed === false ? 'warn' : 'ok'

  const required = env?.filter((e) => e.role === 'required') ?? []
  const requiredOk = required.filter((e) => e.present && e.authed !== false).length
  const issues = env?.filter((e) => !e.present || e.authed === false).length ?? 0

  return (
    <div className="onboard-step">
      <div className="onboard-row-head">
        <h2>Environment check</h2>
        <button className="btn-soft" onClick={run} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      {env && (
        <p className={`onboard-env-summary ${requiredOk === required.length ? 'ok' : 'bad'}`}>
          {requiredOk === required.length
            ? `✓ All ${required.length} required tools are ready${issues ? ` — ${issues} optional item(s) could improve coverage` : ''}.`
            : `${requiredOk}/${required.length} required tools ready — fix the red items below before launch.`}
        </p>
      )}
      {!env && <div className="muted">Scanning…</div>}
      <div className="env-list">
        {env?.map((it) => (
          <div className={`env-item ${cls(it)}`} key={it.id}>
            <span className="env-icon">{icon(it)}</span>
            <div className="env-main">
              <span className="env-label">
                {it.label} <span className={`env-role ${it.role}`}>{it.role}</span>
              </span>
              <span className="env-detail">{it.detail}</span>
              {(!it.present || it.authed === false) && (
                <span className="env-install">→ {it.install}</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function ForgeStep({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const desc = forgeDescriptor(s.forge)
  const field = (k: string) => s.forgeConfig?.[s.forge]?.[k] ?? ''
  const setField = (k: string, v: string) =>
    patch({
      forgeConfig: { ...s.forgeConfig, [s.forge]: { ...(s.forgeConfig?.[s.forge] ?? {}), [k]: v } }
    })
  return (
    <div className="onboard-step">
      <h2>Code forge</h2>
      <p className="muted">
        Where your PRs live. Forge and tracker are independent — Jira with GitHub, Azure Boards with
        GitHub, any combination works.
      </p>
      <label>
        Forge
        <select value={s.forge} onChange={(e) => patch({ forge: e.target.value })}>
          {FORGES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.displayName}
            </option>
          ))}
        </select>
      </label>
      {desc && <p className="muted">{desc.blurb}</p>}

      {s.forge === 'github' && (
        <>
          <label>
            Your GitHub username
            <input
              defaultValue={s.githubUsername}
              placeholder="your-github-username"
              onBlur={(e) => patch({ githubUsername: e.target.value.trim() })}
            />
          </label>
          <label>
            Watched repositories (one per line, <code>owner/repo</code>)
            <textarea
              key={s.watchRepos.join(',')}
              defaultValue={s.watchRepos.join('\n')}
              rows={5}
              placeholder={'owner/repo\nowner/another-repo'}
              onBlur={(e) =>
                patch({
                  watchRepos: e.target.value
                    .split(/[\n,]+/)
                    .map((x) => x.trim())
                    .filter(Boolean)
                })
              }
            />
          </label>
          <p className="muted">
            Clone them under your clone dir (<code>{s.cloneParentDir}</code>) so review/dev
            worktrees can be created.
          </p>
        </>
      )}

      {s.forge !== 'github' &&
        desc?.fields.map((f) =>
          f.type === 'textarea' ? (
            <label key={f.key}>
              {f.label}
              <textarea
                key={field(f.key)}
                defaultValue={field(f.key)}
                placeholder={f.placeholder}
                rows={3}
                onBlur={(e) => setField(f.key, e.target.value)}
              />
              {f.hint && <span className="muted">{f.hint}</span>}
            </label>
          ) : (
            <label key={f.key}>
              {f.label}
              <input
                key={field(f.key)}
                type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                defaultValue={field(f.key)}
                placeholder={f.placeholder}
                onBlur={(e) => setField(f.key, e.target.value)}
              />
              {f.hint && <span className="muted">{f.hint}</span>}
            </label>
          )
        )}
    </div>
  )
}

function TrackerStep({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const desc = trackerDescriptor(s.tracker)
  const field = (k: string) => s.trackerConfig?.[s.tracker]?.[k] ?? ''
  const setField = (k: string, v: string) =>
    patch({
      trackerConfig: { ...s.trackerConfig, [s.tracker]: { ...(s.trackerConfig?.[s.tracker] ?? {}), [k]: v } }
    })
  return (
    <div className="onboard-step">
      <h2>Project tracker</h2>
      <p className="muted">Where your assigned tasks come from — and where finished follow-ups become stories.</p>
      <label>
        Tracker
        <select value={s.tracker} onChange={(e) => patch({ tracker: e.target.value })}>
          {TRACKERS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.displayName}
            </option>
          ))}
        </select>
      </label>
      {desc && <p className="muted">{desc.blurb}</p>}
      {desc?.fields.map((f) =>
        f.type === 'textarea' ? (
          <label key={f.key}>
            {f.label}
            <textarea
              key={field(f.key)}
              defaultValue={field(f.key)}
              placeholder={f.placeholder}
              rows={3}
              onBlur={(e) => setField(f.key, e.target.value)}
            />
          </label>
        ) : (
          <label key={f.key}>
            {f.label}
            <input
              key={field(f.key)}
              type={f.type === 'password' ? 'password' : 'text'}
              defaultValue={field(f.key)}
              placeholder={f.placeholder}
              onBlur={(e) => setField(f.key, e.target.value)}
            />
          </label>
        )
      )}
    </div>
  )
}

function BrainStep({ s, patch }: { s: Settings; patch: (p: Partial<Settings>) => void }) {
  const [test, setTest] = useState<{ status: 'idle' | 'running' | 'ok' | 'fail'; detail: string }>({
    status: 'idle',
    detail: ''
  })
  const runTest = async () => {
    setTest({ status: 'running', detail: '' })
    const r = await api.testLlm()
    setTest({ status: r.ok ? 'ok' : 'fail', detail: `${r.detail} (${r.ms}ms)` })
  }
  return (
    <div className="onboard-step">
      <h2>Brain LLM</h2>
      <p className="muted">
        Orchestration is deterministic; an LLM is consulted only for judgment — reviewing a change,
        unsticking a stalled session, deduplicating suggestions.
      </p>
      <label>
        Provider
        <select
          value={s.llmProvider}
          onChange={(e) => patch({ llmProvider: e.target.value as Settings['llmProvider'] })}
        >
          <option value="local">Local model (OpenAI-compatible, e.g. LM Studio)</option>
          <option value="harness">A harness run headless (no API key needed)</option>
        </select>
      </label>
      {s.llmProvider === 'local' && (
        <>
          <label>
            Endpoint
            <input
              key={s.localLlmEndpoint}
              defaultValue={s.localLlmEndpoint}
              placeholder="http://127.0.0.1:1234"
              onBlur={(e) => patch({ localLlmEndpoint: e.target.value })}
            />
          </label>
          <label>
            Model
            <input defaultValue={s.llmModel} onBlur={(e) => patch({ llmModel: e.target.value })} />
          </label>
        </>
      )}
      {s.llmProvider === 'harness' && (
        <p className="muted">Pick the Brain-default agent on the next step.</p>
      )}
      <div className="row">
        <button className="btn-soft" disabled={test.status === 'running'} onClick={() => void runTest()}>
          {test.status === 'running' ? 'Testing…' : 'Test connection'}
        </button>
        {test.status !== 'idle' && test.status !== 'running' && (
          <span className={`test-result ${test.status}`}>
            {test.status === 'ok' ? '✓' : '✗'} {test.detail}
          </span>
        )}
      </div>
    </div>
  )
}

function HarnessStep({ state }: { state: AppState }) {
  const roles = [
    { key: 'isReviewDefault', label: 'review' },
    { key: 'isBrainDefault', label: 'brain' },
    { key: 'isCodingDefault', label: 'coding' }
  ] as const
  return (
    <div className="onboard-step">
      <h2>Agents &amp; roles</h2>
      <p className="muted">
        Enable the agent CLIs you have installed, then pick exactly one default per role: who
        reviews PRs, who powers brain judgment (if harness-backed), and who writes code.
      </p>
      <div className="harness-table">
        <div className="harness-trow harness-thead onboard-htrow">
          <span />
          <span>enabled</span>
          <span>review</span>
          <span>brain</span>
          <span>coding</span>
        </div>
        {state.harnesses.map((h) => (
          <div className="harness-trow onboard-htrow" key={h.id}>
            <div className="hg-name">
              <span>
                <strong>{h.displayName}</strong> <code>{h.launch.command}</code>
              </span>
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                checked={h.enabled}
                onChange={(e) => void api.upsertHarness({ ...h, enabled: e.target.checked })}
              />
            </div>
            {roles.map((r) => (
              <div className="hg-cell" key={r.key}>
                <input
                  type="radio"
                  name={`onboard-role-${r.label}`}
                  checked={h[r.key]}
                  onChange={() => void api.upsertHarness({ ...h, [r.key]: true })}
                />
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className="muted">Selecting a default automatically clears the previous one — one per role.</p>
    </div>
  )
}

function LaunchStep({ state }: { state: AppState }) {
  const s = state.settings
  // LIVE readiness, derived from real state — not a static congratulation.
  const forgeReady =
    s.forge === 'github'
      ? !!s.githubUsername && (s.watchRepos.length > 0 || !!s.githubReviewFilter)
      : Object.values(s.forgeConfig?.[s.forge] ?? {}).some(Boolean)
  const trackerReady = Object.values(s.trackerConfig?.[s.tracker] ?? {}).some(Boolean)
  const enabledHarnesses = state.harnesses.filter((h) => h.enabled)
  const hasCoding = state.harnesses.some((h) => h.enabled && h.isCodingDefault)
  const hasReview = state.harnesses.some((h) => h.enabled && h.isReviewDefault)
  const clonedRepos = state.repos.filter((r) => r.cloneState === 'present').length

  const items: { ok: boolean; label: string; hint?: string }[] = [
    { ok: forgeReady, label: `Forge: ${s.forge}`, hint: forgeReady ? undefined : 'configure it on the Forge step' },
    { ok: trackerReady, label: `Tracker: ${s.tracker}`, hint: trackerReady ? undefined : 'configure it on the Tracker step' },
    { ok: true, label: `Brain: ${s.llmProvider === 'local' ? `local (${s.llmModel})` : 'harness-backed'}` },
    {
      ok: enabledHarnesses.length > 0 && hasCoding && hasReview,
      label: `Agents: ${enabledHarnesses.length} enabled`,
      hint: hasCoding && hasReview ? undefined : 'set a coding and a review default on the Agents step'
    },
    {
      ok: clonedRepos > 0,
      label: `Repos cloned locally: ${clonedRepos}`,
      hint: clonedRepos > 0 ? undefined : `clone watched repos under ${s.cloneParentDir} (works later too)`
    }
  ]

  return (
    <div className="onboard-step">
      <h2>Ready to launch</h2>
      <div className="onboard-checklist">
        {items.map((it) => (
          <div className={`onboard-check ${it.ok ? 'ok' : 'todo'}`} key={it.label}>
            <span className="onboard-check-icon">{it.ok ? '✓' : '○'}</span>
            <span>{it.label}</span>
            {it.hint && <span className="muted"> — {it.hint}</span>}
          </div>
        ))}
      </div>
      <p>
        Starting the brain begins the poll loop: it pulls your reviews and tasks, spawns sessions,
        and surfaces decisions. Watch its reasoning in <strong>Brain</strong>, drive terminals in{' '}
        <strong>Sessions</strong>, approve in <strong>Reviews</strong>, and turn merged work into
        stories in <strong>Backlog &amp; Insights</strong>.
      </p>
      <p className="muted">
        Unchecked items are fine to fix later. Re-run this walkthrough anytime from{' '}
        <strong>Settings → Setup walkthrough</strong>.
      </p>
    </div>
  )
}
