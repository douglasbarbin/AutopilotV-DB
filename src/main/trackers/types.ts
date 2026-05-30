// Project-tracker adapter contract. Each adapter maps an external tracker
// (Jira, ShipReq, …) to AutopilotV's neutral work-item shape.

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

export interface ProjectTracker {
  id: string
  /** Candidate work items for the user, per the adapter's config. */
  listAssigned(config: Record<string, string>): Promise<TrackerIssue[]>
  /** Move an item to a lifecycle status. Best-effort; throws on hard failure. */
  transition(key: string, target: TransitionTarget, config: Record<string, string>): Promise<void>
  /** Connectivity/auth check for the integration health dot. */
  checkAuth(config: Record<string, string>): Promise<{ ok: boolean; detail: string }>
}
