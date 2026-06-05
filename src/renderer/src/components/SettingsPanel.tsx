import { useState } from 'react'
import type { AppState, Settings } from '@shared/types/domain'
import { TRACKERS, trackerDescriptor } from '@shared/types/trackers'
import { api } from '../api'

export function SettingsPanel({ state }: { state: AppState }) {
  const s = state.settings
  const [test, setTest] = useState<{ status: 'idle' | 'running' | 'ok' | 'fail'; detail: string }>({
    status: 'idle',
    detail: ''
  })
  const repoOptions = Array.from(
    new Set([...state.repos.map((r) => r.name), ...state.settings.watchRepos])
  )
    .filter(Boolean)
    .sort()

  const patch = (p: Partial<Settings>) => void api.updateSettings(p)

  const runTest = async () => {
    setTest({ status: 'running', detail: '' })
    const r = await api.testLlm()
    setTest({ status: r.ok ? 'ok' : 'fail', detail: `${r.detail} (${r.ms}ms)` })
  }

  const activeTracker = trackerDescriptor(s.tracker)
  const trackerField = (key: string) => s.trackerConfig?.[s.tracker]?.[key] ?? ''
  const setTrackerField = (key: string, value: string) =>
    patch({
      trackerConfig: {
        ...s.trackerConfig,
        [s.tracker]: { ...(s.trackerConfig?.[s.tracker] ?? {}), [key]: value }
      }
    })

  return (
    <div className="settings">
      <section>
        <h3>Appearance</h3>
        <label>
          Theme
          <select value={s.theme} onChange={(e) => patch({ theme: e.target.value })}>
            <option value="tomorrow-night-80s">Tomorrow Night 80s</option>
            <option value="tokyo-night">Tokyo Night</option>
            <option value="synthwave">Synthwave</option>
            <option value="tomorrow">Tomorrow (light)</option>
          </select>
        </label>
        <div className="harness-row">
          <div>
            <strong>Setup walkthrough</strong>
            <p className="hint">Re-run the first-start environment + integration walkthrough.</p>
          </div>
          <button className="btn-soft" onClick={() => patch({ onboarded: false })}>
            Run walkthrough
          </button>
        </div>
      </section>

      <section>
        <h3>Brain</h3>
        <label>
          Poll interval (s)
          <input
            type="number"
            defaultValue={s.pollIntervalSeconds}
            onBlur={(e) => patch({ pollIntervalSeconds: Number(e.target.value) })}
          />
        </label>
        <label>
          Max concurrent sessions
          <input
            type="number"
            defaultValue={s.maxConcurrentSessions}
            onBlur={(e) => patch({ maxConcurrentSessions: Number(e.target.value) })}
          />
        </label>
        <label>
          Clone parent dir
          <input
            defaultValue={s.cloneParentDir}
            onBlur={(e) => patch({ cloneParentDir: e.target.value })}
          />
        </label>
      </section>

      <section>
        <h3>GitHub</h3>
        <label>
          GitHub username
          <input
            defaultValue={s.githubUsername}
            placeholder="e.g. your-github-username"
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
        <p className="hint">
          AutopilotV polls each watched repo for PRs where review is requested from your username
          (excluding your own). Clone these repos under your <strong>clone parent dir</strong> so
          review worktrees can be created. Leave the list empty to fall back to the global search
          filter below.
        </p>
        <label>
          Fallback search filter (used only when no repos are watched)
          <input
            defaultValue={s.githubReviewFilter}
            onBlur={(e) => patch({ githubReviewFilter: e.target.value })}
          />
        </label>
      </section>

      <section>
        <h3>Project tracker</h3>
        <label>
          Active tracker
          <select value={s.tracker} onChange={(e) => patch({ tracker: e.target.value })}>
            {TRACKERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.displayName}
              </option>
            ))}
          </select>
        </label>
        {activeTracker && <p className="hint">{activeTracker.blurb}</p>}
        {activeTracker?.fields.map((f) =>
          f.type === 'textarea' ? (
            <label key={f.key}>
              {f.label}
              <textarea
                key={trackerField(f.key)}
                defaultValue={trackerField(f.key)}
                placeholder={f.placeholder}
                rows={4}
                onBlur={(e) => setTrackerField(f.key, e.target.value)}
              />
              {f.hint && <span className="hint">{f.hint}</span>}
            </label>
          ) : (
            <label key={f.key}>
              {f.label}
              <input
                key={trackerField(f.key)}
                type={f.type === 'password' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                defaultValue={trackerField(f.key)}
                placeholder={f.placeholder}
                onBlur={(e) => setTrackerField(f.key, e.target.value)}
              />
              {f.hint && <span className="hint">{f.hint}</span>}
            </label>
          )
        )}
        {state.trackerProjects.length > 0 && (
          <div className="settings-projects">
            <span>Projects (auto-discovered) — enable and map each to a repo for dev work</span>
            {state.trackerProjects.map((p) => (
              <div className="project-map-row" key={p.key}>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={p.enabled}
                    onChange={(e) => void api.toggleTrackerProject(p.key, e.target.checked)}
                  />
                  <span className="proj-key">{p.name || p.key}</span>
                </label>
                <span className="proj-count">{p.openCount} open</span>
                <select
                  value={p.repoName}
                  onChange={(e) => void api.setProjectRepo(p.key, e.target.value)}
                >
                  <option value="">— any cloned repo —</option>
                  {repoOptions.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3>LLM (brain judgment)</h3>
        <label>
          Provider
          <select
            defaultValue={s.llmProvider}
            onChange={(e) => patch({ llmProvider: e.target.value as Settings['llmProvider'] })}
          >
            <option value="local">Local model (OpenAI-compatible)</option>
            <option value="harness">A harness (headless -p)</option>
          </select>
        </label>
        {s.llmProvider === 'local' && (
          <label>
            Model
            <input defaultValue={s.llmModel} onBlur={(e) => patch({ llmModel: e.target.value })} />
          </label>
        )}
        {s.llmProvider === 'local' && (
          <label>
            Local LM endpoint (OpenAI-compatible)
            <input
              key={s.localLlmEndpoint}
              defaultValue={s.localLlmEndpoint}
              placeholder="http://127.0.0.1:1234"
              onBlur={(e) => patch({ localLlmEndpoint: e.target.value })}
            />
          </label>
        )}
        <p className="hint">
          {s.llmProvider === 'harness' ? (
            <>
              The brain runs the harness flagged <strong>Brain default</strong> below headlessly
              (<code>-p</code>) for each judgment, reusing that harness's model/login. Flag one in
              the Harnesses section. Use Test to confirm it returns JSON.
            </>
          ) : (
            <>
              Local judgment posts to your OpenAI-compatible server (LM Studio default is{' '}
              <code>http://127.0.0.1:1234</code>). Set the <strong>Model</strong> to the model id your
              server exposes. With <strong>Local</strong> selected the brain-harness step is skipped.
            </>
          )}
        </p>
        <div className="row test-row">
          <button className="btn-soft" disabled={test.status === 'running'} onClick={() => void runTest()}>
            {test.status === 'running' ? 'Testing…' : 'Test model'}
          </button>
          {test.status !== 'idle' && test.status !== 'running' && (
            <span className={`test-result ${test.status}`}>
              {test.status === 'ok' ? '✓' : '✗'} {test.detail}
            </span>
          )}
        </div>
      </section>

      <section>
        <h3>Agent instructions (AGENTS.md)</h3>
        <label>
          Universal instructions injected into every worktree
          <textarea
            key={s.agentsTemplate}
            defaultValue={s.agentsTemplate}
            rows={10}
            placeholder="## Coding standards&#10;- ..."
            onBlur={(e) => patch({ agentsTemplate: e.target.value })}
          />
        </label>
        <p className="hint">
          This content is appended to the bottom of each worktree's <code>AGENTS.md</code> (created
          if absent) before any agent runs, and is git-ignored so it's never committed. Refine it
          over time to raise output quality and enforce coding standards. Leave empty to inject
          nothing.
        </p>
      </section>

      <section>
        <h3>Dev line</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            defaultChecked={s.autoPublish}
            onChange={(e) => patch({ autoPublish: e.target.checked })}
          />
          Auto-publish draft PRs (otherwise they wait for your Publish click)
        </label>
        <label>
          Required approvals before ready-to-merge
          <input
            type="number"
            min={0}
            defaultValue={s.requiredApprovals}
            onBlur={(e) => patch({ requiredApprovals: Number(e.target.value) })}
          />
        </label>
        <label>
          Feature branch prefix
          <input
            defaultValue={s.branchPrefix}
            placeholder="autopilotv/"
            onBlur={(e) => patch({ branchPrefix: e.target.value })}
          />
        </label>
        <label>
          Terminal command (optional; <code>{'{dir}'}</code> = worktree path)
          <input
            defaultValue={s.terminalCommand}
            placeholder="kitty --directory {dir}"
            onBlur={(e) => patch({ terminalCommand: e.target.value })}
          />
        </label>
        <p className="hint">
          A dev task becomes <strong>ready to merge</strong> only when it has at least this many
          approvals, zero unresolved review threads, and GitHub reports it mergeable. Merging always
          waits for your click.
        </p>
      </section>

      <section>
        <h3>Auto-drive</h3>
        <label className="checkbox">
          <input
            type="checkbox"
            defaultChecked={s.autoDrive.enabled}
            onChange={(e) => patch({ autoDrive: { ...s.autoDrive, enabled: e.target.checked } })}
          />
          Auto-drive new sessions by default (toggle per-session in the Sessions tab)
        </label>
        <label>
          Max injections / session
          <input
            type="number"
            defaultValue={s.autoDrive.maxInjectionsPerSession}
            onBlur={(e) =>
              patch({
                autoDrive: { ...s.autoDrive, maxInjectionsPerSession: Number(e.target.value) }
              })
            }
          />
        </label>
        <label>
          Destructive denylist (comma-separated)
          <input
            defaultValue={s.autoDrive.destructiveDenylist.join(', ')}
            onBlur={(e) =>
              patch({
                autoDrive: {
                  ...s.autoDrive,
                  destructiveDenylist: e.target.value
                    .split(',')
                    .map((x) => x.trim())
                    .filter(Boolean)
                }
              })
            }
          />
        </label>
      </section>

      <HarnessList state={state} />
      <RepoList state={state} />
      <DangerZone />
    </div>
  )
}

function DangerZone() {
  const wipe = () => {
    const ok = window.confirm(
      'Wipe the AutopilotV database?\n\nThis permanently deletes all tasks, PR reviews, sessions, ' +
        'reviews, worktree records, events, project toggles, and settings — then reseeds defaults. ' +
        'Live sessions are killed. This cannot be undone.'
    )
    if (ok) void api.wipeDb()
  }
  return (
    <section className="danger-zone">
      <h3>Danger zone</h3>
      <div className="harness-row">
        <div>
          <strong>Wipe database</strong>
          <p className="hint">
            Deletes everything in <code>autopilotv.db</code> and reseeds default harnesses/settings.
            Kills any running sessions.
          </p>
        </div>
        <button className="danger" onClick={wipe}>
          Wipe database
        </button>
      </div>
    </section>
  )
}

function HarnessList({ state }: { state: AppState }) {
  return (
    <section>
      <h3>Harnesses</h3>
      <p className="hint">
        Each role (review · brain · coding) uses one default harness; setting a default clears it on
        the others. <em>native</em> (Pi only) makes review sessions use Pi's own config.
      </p>
      <div className="harness-table">
        <div className="harness-trow harness-thead">
          <span />
          <span>enabled</span>
          <span>review</span>
          <span>brain</span>
          <span>coding</span>
          <span>native</span>
          <span />
        </div>
        {state.harnesses.map((h) => (
          <div className="harness-trow" key={h.id}>
            <div className="hg-name">
              <span>
                <strong>{h.displayName}</strong> <code>{h.launch.command}</code>
              </span>
              {h.localModel && <span className="badge task">local: {h.localModel.name}</span>}
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                title="enabled"
                checked={h.enabled}
                onChange={(e) => void api.upsertHarness({ ...h, enabled: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                title="review default"
                checked={h.isReviewDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isReviewDefault: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                title="brain default"
                checked={h.isBrainDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isBrainDefault: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              <input
                type="checkbox"
                title="coding default"
                checked={h.isCodingDefault}
                onChange={(e) => void api.upsertHarness({ ...h, isCodingDefault: e.target.checked })}
              />
            </div>
            <div className="hg-cell">
              {h.launch.command === 'pi' ? (
                <input
                  type="checkbox"
                  title="Use Pi's own ~/.pi config for review (bypass managed local model)"
                  checked={!!h.nativeReviewConfig}
                  onChange={(e) =>
                    void api.upsertHarness({ ...h, nativeReviewConfig: e.target.checked })
                  }
                />
              ) : null}
            </div>
            <div className="hg-cell">
              {h.localModel && (
                <button className="btn-soft" onClick={() => void api.startLocalModel(h.id)}>
                  Start
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function RepoList({ state }: { state: AppState }) {
  return (
    <section>
      <h3>Repos</h3>
      {state.repos.length === 0 && (
        <div className="empty">
          Repos are auto-discovered from PRs. Clone them under your clone parent dir so AutopilotV can
          find them.
        </div>
      )}
      {state.repos.map((r) => (
        <div className="harness-row" key={r.id}>
          <div>
            <strong>{r.name}</strong>
            <span className={`badge ${r.cloneState === 'present' ? 'task' : 'review'}`}>
              {r.cloneState}
            </span>
          </div>
          <code>{r.path ?? '— not cloned locally —'}</code>
        </div>
      ))}
    </section>
  )
}
