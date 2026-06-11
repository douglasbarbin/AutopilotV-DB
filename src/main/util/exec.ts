import { execFile } from 'child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Strip package-manager lifecycle variables from a child environment.
 *
 * AutopilotV is usually launched via an npm script, so process.env carries
 * npm's per-invocation vars (npm_config_local_prefix, npm_package_*,
 * npm_lifecycle_*, INIT_CWD, NODE_ENV, …) pointing at AutopilotV's OWN repo.
 * Inherited by agent sessions and verify commands running in OTHER repos'
 * worktrees, they corrupt npm's command/config resolution there (reported
 * from the field: a stale npm_config_local_prefix broke installs inside a
 * session worktree). Every child process — PTY sessions, exec'd CLIs, shell
 * verify commands — gets a cleaned environment.
 */
const LIFECYCLE_VARS = new Set(['INIT_CWD', 'NODE_ENV', 'PNPM_SCRIPT_SRC_DIR', 'PROJECT_CWD'])

export function sanitizeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^npm_/i.test(k) || LIFECYCLE_VARS.has(k)) continue
    out[k] = v
  }
  return out
}

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  input?: string
}

/**
 * Run a command without a shell (no interpolation / injection surface).
 * Resolves with the result regardless of exit code; callers inspect `code`.
 */
export function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        // Sanitized unconditionally: explicit envs are built from process.env
        // by callers (sandbox, llm provider) and inherit the same leak.
        env: sanitizeChildEnv(opts.env ?? process.env),
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: 32 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        const code = err && typeof (err as any).code === 'number' ? (err as any).code : err ? 1 : 0
        resolve({ stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '', code })
      }
    )
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input)
      child.stdin.end()
    }
  })
}

/**
 * Run an operator-configured command line THROUGH a shell, so compound commands
 * (`npm run lint && npm test`) and shell features work. Used for the per-repo
 * verification command (theme B). The command string is configured by the
 * operator (or auto-detected), never built from untrusted external data.
 * Returns combined stdout, stderr, and exit code like `exec`.
 */
export function execShell(
  command: string,
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const isWin = process.platform === 'win32'
  const shell = isWin ? 'cmd.exe' : '/bin/sh'
  const args = isWin ? ['/c', command] : ['-c', command]
  return exec(shell, args, opts)
}

/** Like exec but throws on non-zero exit, returning stdout. */
export async function execOrThrow(
  cmd: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<string> {
  const r = await exec(cmd, args, opts)
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited ${r.code}: ${r.stderr || r.stdout}`)
  }
  return r.stdout
}
