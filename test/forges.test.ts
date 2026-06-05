import { vi, describe, it, expect } from 'vitest'

// Mock the log module to keep test output clean.
vi.mock('../src/main/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { activeForge, forgeForRepo, getForge, listForges } from '../src/main/forges'
import type { Settings } from '../src/shared/types/domain'

const SETTINGS: Settings = {
  pollIntervalSeconds: 60,
  maxConcurrentSessions: 3,
  cloneParentDir: '/tmp/repos',
  tracker: 'jira',
  trackerConfig: {},
  forge: 'azuredevops',
  forgeConfig: {
    github: {},
    azuredevops: { org: 'myorg', project: 'MyProject', pat: 'pat123' }
  },
  githubUsername: '',
  watchRepos: [],
  githubReviewFilter: '',
  llmProvider: 'local',
  llmModel: '',
  localLlmEndpoint: '',
  autoDrive: { enabled: false, maxInjectionsPerSession: 0, destructiveDenylist: [] },
  notifications: { reviewReady: false, needsHuman: false, prReadyToMerge: false },
  mergePolicy: 'await_user',
  autoPublish: false,
  requiredApprovals: 1,
  agentsTemplate: '',
  branchPrefix: 'autopilotv/',
  terminalCommand: '',
  theme: 'tomorrow-night-80s',
  onboarded: true
}

describe('forge registry', () => {
  it('returns the GitHub adapter for id=github', () => {
    expect(getForge('github').id).toBe('github')
  })

  it('returns the Azure DevOps adapter for id=azuredevops', () => {
    expect(getForge('azuredevops').id).toBe('azuredevops')
  })

  it('falls back to GitHub for unknown ids', () => {
    expect(getForge('mystery').id).toBe('github')
  })

  it('listForges returns at least the two known adapters', () => {
    const ids = listForges().map((f) => f.id).sort()
    expect(ids).toEqual(['azuredevops', 'github'])
  })
})

describe('activeForge', () => {
  it('returns the adapter + config slice named by settings.forge', () => {
    const { forge, config } = activeForge(SETTINGS)
    expect(forge.id).toBe('azuredevops')
    expect(config.org).toBe('myorg')
    expect(config.pat).toBe('pat123')
  })

  it('returns an empty config object when the slice is absent', () => {
    const settings: Settings = { ...SETTINGS, forge: 'github' }
    const { forge, config } = activeForge(settings)
    expect(forge.id).toBe('github')
    expect(config).toEqual({})
  })
})

describe('forgeForRepo', () => {
  it('uses the repo forge even when the active setting differs', () => {
    const repo = {
      id: 1,
      name: 'myorg/MyProject/widgets',
      path: null,
      remote: '',
      defaultBranch: 'main',
      cloneState: 'missing' as const,
      forge: 'azuredevops'
    }
    const settings: Settings = { ...SETTINGS, forge: 'github' }
    const { forge, config } = forgeForRepo(repo, settings)
    expect(forge.id).toBe('azuredevops')
    expect(config.org).toBe('myorg')
  })

  it('falls back to the active setting for legacy repos (no forge column)', () => {
    const repo = {
      id: 1,
      name: 'acme/widgets',
      path: null,
      remote: '',
      defaultBranch: 'main',
      cloneState: 'missing' as const,
      forge: ''
    }
    const { forge } = forgeForRepo(repo, SETTINGS)
    expect(forge.id).toBe('azuredevops') // active setting
  })

  it('falls back to github for null repos', () => {
    const { forge } = forgeForRepo(null, { ...SETTINGS, forge: 'github' })
    expect(forge.id).toBe('github')
  })
})
