import { execFile } from 'child_process'

export interface ExecResult {
  stdout: string
  stderr: string
  code: number
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
        env: opts.env ?? process.env,
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
