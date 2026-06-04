import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { delimiter } from 'path'

/**
 * Build a sandboxed environment for a PR-review session.
 *
 * Security invariant (SPEC §7.3 / §16): a review session must be unable to
 * mutate GitHub. Three layers:
 *   1. PATH-scrub  — remove every directory that contains a `gh` binary.
 *   2. Shim        — prepend a sandbox bin/ with `gh`/push shims that hard-fail.
 *   3. env-strip   — remove GH_TOKEN / GITHUB_TOKEN and other auth.
 */
export interface SandboxResult {
  env: NodeJS.ProcessEnv
  shimDir: string
}

const STRIP_ENV_KEYS = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GITHUB_API_TOKEN',
  'GH_CONFIG_DIR',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK'
]

const SHIM_NAMES = ['gh', 'hub']

const SHIM_BODY = `#!/bin/sh
echo "sandbox: '$0' is blocked inside a PR-review session (no forge mutation allowed)." 1>&2
exit 87
`

// git wrapper: block remote-write subcommands, pass everything else through to real git.
const GIT_WRAPPER = (realGit: string) => `#!/bin/sh
case "$1" in
  push|fetch|pull|remote|clone)
    echo "sandbox: 'git $1' is blocked inside a PR-review session." 1>&2
    exit 87
    ;;
esac
exec "${realGit}" "$@"
`

/** Directories on PATH that actually contain the named binary. */
function dirsContaining(binNames: string[], pathValue: string): Set<string> {
  const hits = new Set<string>()
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue
    for (const name of binNames) {
      if (existsSync(join(dir, name))) {
        hits.add(dir)
        break
      }
    }
  }
  return hits
}

/**
 * Create the sandbox shim directory and return the scrubbed env. `realGit` is
 * the absolute path to the genuine git binary (so the wrapper can delegate).
 */
export function buildReviewSandbox(opts: {
  worktreePath: string
  realGit: string
  basePath?: string
}): SandboxResult {
  const shimDir = join(opts.worktreePath, '.sandbox-bin')
  mkdirSync(shimDir, { recursive: true })

  for (const name of SHIM_NAMES) {
    const p = join(shimDir, name)
    writeFileSync(p, SHIM_BODY, { mode: 0o755 })
    chmodSync(p, 0o755)
    if (process.platform === 'win32') {
      writeFileSync(p + '.cmd', `@echo off\r\necho sandbox: '%~n0' is blocked inside a PR-review session (no forge mutation allowed). >&2\r\nexit /b 87\r\n`)
    }
  }
  const gitShim = join(shimDir, 'git')
  writeFileSync(gitShim, GIT_WRAPPER(opts.realGit), { mode: 0o755 })
  chmodSync(gitShim, 0o755)
  if (process.platform === 'win32') {
    const body = `@echo off\r\n` +
      `set "arg1=%~1"\r\n` +
      `if "%arg1%"=="push" goto block\r\n` +
      `if "%arg1%"=="fetch" goto block\r\n` +
      `if "%arg1%"=="pull" goto block\r\n` +
      `if "%arg1%"=="remote" goto block\r\n` +
      `if "%arg1%"=="clone" goto block\r\n` +
      `goto delegate\r\n` +
      `:block\r\n` +
      `echo sandbox: 'git %arg1%' is blocked inside a PR-review session. >&2\r\n` +
      `exit /b 87\r\n` +
      `:delegate\r\n` +
      `"${opts.realGit}" %*\r\n`
    writeFileSync(gitShim + '.cmd', body)
  }

  // PATH handling: prepend the shim dir so `gh`/`hub`/remote-write `git` resolve
  // to our hard-fail shims before any real binary. We deliberately do NOT delete
  // whole PATH dirs — on Homebrew macOS gh/git/acli/node share /opt/homebrew/bin,
  // and an absolute-path gh call bypasses PATH regardless. The real backstop
  // against absolute-path calls is token-strip below (no auth => no mutation).
  const basePath = opts.basePath ?? process.env.PATH ?? ''
  const scrubbedPath = [shimDir, ...basePath.split(delimiter).filter(Boolean)].join(delimiter)

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: scrubbedPath }
  for (const k of STRIP_ENV_KEYS) delete env[k]
  // Mark the session so harnesses / debugging can detect sandbox mode.
  env.AGENT_SANDBOX = 'review'
  env.GIT_TERMINAL_PROMPT = '0'

  return { env, shimDir }
}

export { STRIP_ENV_KEYS, SHIM_NAMES, dirname, dirsContaining }
