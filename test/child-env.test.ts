/**
 * Child-environment sanitization: npm lifecycle variables from AutopilotV's
 * own launch (npm run dev) must not leak into agent sessions or exec'd
 * commands running in other repos' worktrees.
 */
import { describe, it, expect } from 'vitest'
import { sanitizeChildEnv, execShell } from '../src/main/util/exec'

describe('sanitizeChildEnv', () => {
  it('strips npm lifecycle vars and keeps everything else', () => {
    const out = sanitizeChildEnv({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      npm_config_local_prefix: '/Users/x/RiderProjects/Taskman',
      npm_lifecycle_event: 'dev',
      npm_package_name: 'autopilotv',
      npm_node_execpath: '/usr/local/bin/node',
      INIT_CWD: '/Users/x/RiderProjects/Taskman',
      NODE_ENV: 'development',
      PNPM_SCRIPT_SRC_DIR: '/somewhere',
      OPENAI_API_KEY: 'local',
      TERM: 'xterm-256color'
    })
    expect(out).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/x',
      OPENAI_API_KEY: 'local',
      TERM: 'xterm-256color'
    })
  })

  it('exec strips the vars even when an explicit env is passed', async () => {
    const r = await execShell('echo "prefix=[$npm_config_local_prefix] home=[$HOME]"', {
      env: { ...process.env, npm_config_local_prefix: '/stale/project', HOME: '/Users/x' }
    })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('prefix=[] home=[/Users/x]')
  })
})
