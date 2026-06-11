// Project-tracker adapter contract. Each adapter maps an external tracker
// (Jira, Vikunja, …) to AutopilotV's neutral work-item shape.

export interface TrackerIssue {
  key: string
  title: string
  status: string // raw tracker status name
  assignee: string
  priority: number // 1..5 (higher = more important)
  issueType: string
  sprint: string
  projectKey: string
  projectName: string
}

export type TransitionTarget = 'In Progress' | 'In Review'

/** A new work item to create from the Backlog & Insights pane (human-gated). */
export interface IssueDraft {
  /** Tracker-native project key/id (Jira project key, Vikunja project id, …). */
  projectKey: string
  title: string
  description: string
  /** AutopilotV follow-up kind (todo/tech_debt/bug/…); adapters map it to a native type. */
  kind: string
  priority: 'low' | 'medium' | 'high'
  /** owner/repo of the originating repo — needed by repo-centric trackers (GitHub). */
  repoName?: string
}

export interface ProjectTracker {
  id: string
  /** What this adapter supports beyond the read+transition baseline. */
  capabilities?: { createIssue?: boolean }
  /** Candidate work items for the user, per the adapter's config. */
  listAssigned(config: Record<string, string>): Promise<TrackerIssue[]>
  /** Move an item to a lifecycle status. Best-effort; throws on hard failure. */
  transition(key: string, target: TransitionTarget, config: Record<string, string>): Promise<void>
  /** Connectivity/auth check for the integration health dot. */
  checkAuth(config: Record<string, string>): Promise<{ ok: boolean; detail: string }>
  /** Create a work item ("Create story"). Throws on failure. */
  createIssue?(draft: IssueDraft, config: Record<string, string>): Promise<{ key: string; url?: string }>
}
