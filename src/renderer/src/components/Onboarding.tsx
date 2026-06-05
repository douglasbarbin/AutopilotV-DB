import { useEffect, useState } from 'react'
import type { AppState, Settings } from '@shared/types/domain'
import type { EnvItem } from '@shared/types/ipc'
import { TRACKERS, trackerDescriptor } from '@shared/types/trackers'
import { FORGES, forgeDescriptor } from '@shared/types/forges'
import { api } from '../api'

const STEPS = ['Welcome', 'Environment', 'Forge', 'Tracker', 'Brain', 'Harnesses', 'Done'] as const

export function Onboarding({ state }: { state: AppState }) {
  const s = state.settings
  const [step, setStep] = useState(0)
  const patch = (p: Partial<Settings>) => void api.updateSettings(p)

  const next = () => setStep((i) => Math.min(i + 1, STEPS.length - 1))
  const back = () => setStep((i) => Math.max(i - 1, 0))
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
              <span
                key={label}
                className={`onboard-dot ${i === step ? 'active' : ''} ${i < step ? 'done' : ''}`}
                title={label}
              />
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
          {step === 6 && <DoneStep />}
        </div>

        <div className="onboard-foot">
          <button
            className="btn-ghost"
            onClick={() => void api.updateSettings({ onboarded: true })}
          >
            Skip
          </button>
          <div className="onboard-nav">
            {step > 0 && (
              <button className="btn-ghost" onClick={back}>
                Back
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button className="btn-primary" onClick={next}>
                Next
              </button>
            ) : (
              <button className="btn-primary" onClick={finish}>
                Finish & start the brain
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
      <h2>Welcome aboard 🚀</h2>
      <p>
        AutopilotV finds the work that's yours — PRs awaiting your review and tasks
        assigned to you — and drives it through coding agents in real terminals,
        stopping for your approval and merge.
      </p>
      <p className="muted">A few minutes of setup and you'll be flying. Here's the recommended kit:</p>
      <ul className="onboard-list">
        <li>
          <strong>git</strong> + a <strong>code forge</strong> — GitHub (uses the <code>gh</code>{' '}
          CLI) or Azure DevOps Repos (REST API).
        </li>
        <li>
          A <strong>project tracker</strong> — Jira (acli), GitHub Projects, Azure DevOps Boards,
          or Vikunja.
        </li>
        <li>
          At least one <strong>coding agent CLI</strong> — Claude Code is recommended; Pi, Codex,
          Cursor, and OpenCode also work.
        </li>
        <li>
          Optional: a <strong>local LLM</strong> (e.g. LM Studio) for the brain or local-model
          harnesses.
        </li>
      </ul>
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

  const icon = (it: EnvItem) =>
    !it.present ? '✗' : it.authed === false ? '!' : '✓'
  const cls = (it: EnvItem) =>
    !it.present ? (it.role === 'optional' ? 'warn' : 'bad') : it.authed === false ? 'warn' : 'ok'

  return (
    <div className="onboard-step">
      <div className="onboard-row-head">
        <h2>Environment check</h2>
        <button className="btn-soft" onClick={run} disabled={loading}>
          {loading ? 'Checking…' : 'Re-check'}
        </button>
      </div>
      <p className="muted">
        Required items must be green to operate; recommended/optional improve coverage.
      </p>
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
        Pick the forge that hosts your PRs. Tracker and forge are independent — you can use Jira
        with GitHub, or Azure DevOps Boards with GitHub, etc.
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
      <p className="muted">The brain calls an LLM only for judgment (reviewing, unsticking, triage).</p>
      <label>
        Provider
        <select
          value={s.llmProvider}
          onChange={(e) => patch({ llmProvider: e.target.value as Settings['llmProvider'] })}
        >
          <option value="local">Local model (OpenAI-compatible)</option>
          <option value="harness">A harness (headless -p)</option>
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
        <p className="muted">Flag a harness as the Brain default in the next step.</p>
      )}
      <div className="row">
        <button className="btn-soft" disabled={test.status === 'running'} onClick={() => void runTest()}>
          {test.status === 'running' ? 'Testing…' : 'Test'}
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
  return (
    <div className="onboard-step">
      <h2>Harnesses & roles</h2>
      <p className="muted">
        Enable the agents you have, and pick one default for each role (review · brain · coding).
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
            <div className="hg-cell">
              <input
                type="checkbox"
                checked={h.isReviewDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isReviewDefault: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                checked={h.isBrainDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isBrainDefault: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                checked={h.isCodingDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isCodingDefault: e.target.checked })}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function DoneStep() {
  return (
    <div className="onboard-step">
      <h2>You're set 🛰️</h2>
      <p>
        Finishing turns the brain on. It polls on an interval; hit <strong>Tick now</strong> any time
        to refresh immediately. Watch its decisions in the <strong>Brain</strong> tab, drive sessions
        in <strong>Sessions</strong>, and approve reviews in <strong>Reviews</strong>.
      </p>
      <p className="muted">
        You can re-run this walkthrough anytime from <strong>Settings → Setup walkthrough</strong>.
      </p>
    </div>
  )
}
