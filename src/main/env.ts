import { exec } from './util/exec'
import { getSettings, listHarnesses } from './store'
import { pingEndpoint } from './localmodel/manager'
import type { EnvItem } from '@shared/types/ipc'

async function present(cmd: string): Promise<{ found: boolean; version: string }> {
  const w = await exec('which', [cmd], { timeoutMs: 5000 })
  if (w.code !== 0) return { found: false, version: '' }
  const v = await exec(cmd, ['--version'], { timeoutMs: 6000 })
  const version = (v.stdout || v.stderr).split('\n')[0]?.trim() ?? ''
  return { found: true, version }
}

const HARNESS_INSTALL: Record<string, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code  ·  claude.ai/code',
  pi: 'npm i -g @earendil-works/pi-coding-agent',
  codex: 'npm i -g @openai/codex',
  'cursor-agent': 'cursor.com — install the Cursor agent CLI',
  opencode: 'npm i -g opencode-ai  ·  opencode.ai'
}

/**
 * Inspect the local environment for the tools AutopilotV relies on, with
 * install/auth hints. Drives the setup walkthrough and a Settings health view.
 */
export async function checkEnvironment(): Promise<EnvItem[]> {
  const items: EnvItem[] = []
  const settings = getSettings()

  // --- core ---
  const git = await present('git')
  items.push({
    id: 'git',
    label: 'git',
    role: 'required',
    present: git.found,
    authed: null,
    detail: git.found ? git.version : 'not found on PATH',
    install: 'Install Xcode Command Line Tools (xcode-select --install) or git'
  })

  const gh = await present('gh')
  let ghAuthed: boolean | null = null
  if (gh.found) ghAuthed = (await exec('gh', ['auth', 'status'], { timeoutMs: 8000 })).code === 0
  items.push({
    id: 'gh',
    label: 'GitHub CLI (gh)',
    role: 'required',
    present: gh.found,
    authed: ghAuthed,
    detail: !gh.found
      ? 'not found on PATH'
      : ghAuthed
        ? gh.version
        : 'installed but not authenticated — run: gh auth login',
    install: 'https://cli.github.com'
  })

  // --- active tracker ---
  if (settings.tracker === 'jira') {
    const acli = await present('acli')
    let acliAuthed: boolean | null = null
    if (acli.found)
      acliAuthed = (await exec('acli', ['jira', 'auth', 'status'], { timeoutMs: 8000 })).code === 0
    items.push({
      id: 'acli',
      label: 'Atlassian CLI (acli) — Jira',
      role: 'recommended',
      present: acli.found,
      authed: acliAuthed,
      detail: !acli.found
        ? 'not found on PATH'
        : acliAuthed
          ? acli.version
          : 'installed but not authenticated — run: acli jira auth login',
      install: 'developer.atlassian.com/cloud/acli'
    })
  } else if (settings.tracker === 'shipreq') {
    const ep = settings.trackerConfig?.shipreq?.endpoint ?? ''
    const ok = ep ? await pingEndpoint(ep, '/api/health', 4000) : false
    items.push({
      id: 'shipreq',
      label: 'ShipReq endpoint',
      role: 'required',
      present: !!ep,
      authed: ep ? ok : null,
      detail: !ep ? 'no endpoint set in Tracker settings' : ok ? `reachable: ${ep}` : `unreachable: ${ep}`,
      install: 'Point Tracker settings at your ShipReq instance'
    })
  }
  // ghproject needs only gh, already checked.

  // --- harnesses (from configured set) ---
  for (const h of listHarnesses()) {
    const p = await present(h.launch.command)
    items.push({
      id: `harness:${h.id}`,
      label: `${h.displayName} (${h.launch.command})`,
      role: h.id === 'claude' || h.id === 'pi' ? 'recommended' : 'optional',
      present: p.found,
      authed: null,
      detail: p.found ? p.version || 'found' : 'not found on PATH',
      install: HARNESS_INSTALL[h.launch.command] ?? `Install the ${h.launch.command} CLI`
    })
  }

  // --- local LLM endpoint (if the brain or a harness uses one) ---
  const usesLocal =
    settings.llmProvider === 'local' || listHarnesses().some((h) => h.localModel)
  if (usesLocal) {
    const ok = await pingEndpoint(settings.localLlmEndpoint)
    items.push({
      id: 'localllm',
      label: 'Local LLM server',
      role: 'recommended',
      present: ok,
      authed: null,
      detail: ok ? `online: ${settings.localLlmEndpoint}` : `offline: ${settings.localLlmEndpoint}`,
      install: 'LM Studio (lmstudio.ai) or any OpenAI-compatible server'
    })
  }

  return items
}
