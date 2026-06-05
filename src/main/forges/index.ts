import type { Repo, Settings } from '@shared/types/domain'
import type { Forge, ForgeConfig } from './types'
import { githubForge } from './github'
import { azureDevOpsForge } from './azuredevops'

/**
 * Code-forge registry. Mirrors src/main/trackers/ — the project tracker and
 * the code forge are both pluggable and independent: a Jira shop can still use
 * GitHub PRs, a GitHub shop can still use Azure DevOps Boards, etc.
 *
 * Adding a new forge = implement the `Forge` interface and register it here.
 */
const REGISTRY: Record<string, Forge> = {
  github: githubForge,
  azuredevops: azureDevOpsForge
}

export function getForge(id: string): Forge {
  return REGISTRY[id] ?? githubForge
}

/** Resolve the active forge and its config from settings. */
export function activeForge(settings: Settings): { forge: Forge; config: ForgeConfig } {
  const forge = getForge(settings.forge)
  const config = settings.forgeConfig?.[settings.forge] ?? {}
  return { forge, config }
}

/**
 * Resolve the forge that owns a particular repo + its config. Always uses the
 * repo's `forge` column (set at upsert time) so a PR is always routed back to
 * the adapter that created the row, even if the user has since switched the
 * active forge. Falls back to the active forge for legacy repos.
 */
export function forgeForRepo(
  repo: Repo | null,
  settings: Settings
): { forge: Forge; config: ForgeConfig } {
  if (repo?.forge) {
    const forge = getForge(repo.forge)
    const config = settings.forgeConfig?.[repo.forge] ?? {}
    return { forge, config }
  }
  return activeForge(settings)
}

export function listForges(): Forge[] {
  return Object.values(REGISTRY)
}

export type { Forge, ForgePr, AdoptablePr, PrReadiness, ForgeConfig, ForgeAuthStatus } from './types'
