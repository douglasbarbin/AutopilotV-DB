import type { Settings } from '@shared/types/domain'
import type { ProjectTracker } from './types'
import { jiraTracker } from './jira'
import { shipreqTracker } from './shipreq'
import { ghProjectTracker } from './ghproject'

const REGISTRY: Record<string, ProjectTracker> = {
  jira: jiraTracker,
  shipreq: shipreqTracker,
  ghproject: ghProjectTracker
}

export function getTracker(id: string): ProjectTracker {
  return REGISTRY[id] ?? jiraTracker
}

/** Resolve the active tracker and its config from settings. */
export function activeTracker(settings: Settings): { tracker: ProjectTracker; config: Record<string, string> } {
  const tracker = getTracker(settings.tracker)
  const config = settings.trackerConfig?.[settings.tracker] ?? {}
  return { tracker, config }
}

export type { ProjectTracker, TrackerIssue } from './types'
