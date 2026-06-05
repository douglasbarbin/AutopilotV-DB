import { existsSync } from 'fs'
import { join } from 'path'
import { getDb } from './_db'
import { getSettings } from './settings'
import type { Repo } from '@shared/types/domain'

interface RepoRow {
  id: number
  name: string
  path: string | null
  remote: string
  default_branch: string
  clone_state: string
  forge: string | null
}

function rowToRepo(r: RepoRow): Repo {
  return {
    id: r.id,
    name: r.name,
    path: r.path,
    remote: r.remote,
    defaultBranch: r.default_branch,
    cloneState: r.clone_state as Repo['cloneState'],
    forge: r.forge ?? 'github'
  }
}

export function listRepos(): Repo[] {
  const rows = getDb().prepare('SELECT * FROM repos ORDER BY name').all() as RepoRow[]
  return rows.map(rowToRepo)
}

export function getRepo(id: number): Repo | null {
  const row = getDb().prepare('SELECT * FROM repos WHERE id = ?').get(id) as RepoRow | undefined
  return row ? rowToRepo(row) : null
}

export function getRepoByName(name: string): Repo | null {
  const row = getDb().prepare('SELECT * FROM repos WHERE name = ?').get(name) as RepoRow | undefined
  return row ? rowToRepo(row) : null
}

export function upsertRepo(r: {
  name: string
  remote: string
  defaultBranch?: string
  path?: string | null
  forge?: string
}): Repo {
  const forge = r.forge ?? getSettings().forge
  getDb()
    .prepare(
      `INSERT INTO repos (name, remote, default_branch, path, clone_state, forge)
       VALUES (@name, @remote, @default_branch, @path, @clone_state, @forge)
       ON CONFLICT(name) DO UPDATE SET remote = @remote`
    )
    .run({
      name: r.name,
      remote: r.remote,
      default_branch: r.defaultBranch ?? 'main',
      path: r.path ?? null,
      clone_state: r.path ? 'present' : 'missing',
      forge
    })
  return getRepoByName(r.name)!
}

export function setRepoCloneState(id: number, state: Repo['cloneState'], path?: string): void {
  getDb()
    .prepare('UPDATE repos SET clone_state = ?, path = COALESCE(?, path) WHERE id = ?')
    .run(state, path ?? null, id)
}

/**
 * Resolve the repo a project's tasks should target, per the user's mapping.
 * Ensures the repo row exists and detects a local clone under the clone dir.
 * Returns null if the project has no mapping.
 */
export function resolveProjectRepo(projectKey: string): Repo | null {
  const row = getDb()
    .prepare('SELECT repo_name FROM tracker_projects WHERE key = ?')
    .get(projectKey) as { repo_name: string } | undefined
  const name = row?.repo_name
  if (!name) return null
  let repo = getRepoByName(name)
  if (!repo) {
    const forge = getSettings().forge
    repo = upsertRepo({
      name,
      remote: forge === 'azuredevops' ? '' : `https://github.com/${name}.git`,
      forge
    })
  }
  if (repo.cloneState !== 'present') {
    const candidate = join(getSettings().cloneParentDir, name.split('/').pop()!)
    if (existsSync(join(candidate, '.git'))) {
      setRepoCloneState(repo.id, 'present', candidate)
      repo = getRepoByName(name)!
    }
  }
  return repo
}
