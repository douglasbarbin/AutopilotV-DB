// Project-tracker adapter descriptors. These are pure metadata shared with the
// renderer so the UI can render the active adapter's settings fields. The actual
// implementations live in src/main/trackers/.

export type TrackerFieldType = 'text' | 'textarea' | 'password' | 'number'

export interface TrackerField {
  key: string
  label: string
  type: TrackerFieldType
  placeholder?: string
  hint?: string
}

export interface TrackerDescriptor {
  id: string
  displayName: string
  blurb: string
  /** Settings fields shown when this adapter is active. Stored in settings.trackerConfig[id]. */
  fields: TrackerField[]
}

export const TRACKERS: TrackerDescriptor[] = [
  {
    id: 'jira',
    displayName: 'Jira',
    blurb: 'Atlassian Jira via the acli CLI.',
    fields: [
      {
        key: 'jql',
        label: 'JQL — the candidate work queue',
        type: 'textarea',
        placeholder:
          'assignee = currentUser() AND sprint in openSprints() AND issuetype != Epic AND statusCategory != Done ORDER BY priority DESC',
        hint: 'Items this query returns become the assigned-tasks queue.'
      }
    ]
  },
  {
    id: 'ghproject',
    displayName: 'GitHub Projects',
    blurb: 'A GitHub Projects (v2) board via the gh CLI. Status is read from the board.',
    fields: [
      { key: 'owner', label: 'Owner (user or org)', type: 'text', placeholder: 'your-org' },
      { key: 'projectNumber', label: 'Project number', type: 'text', placeholder: '7' },
      {
        key: 'username',
        label: 'Assignee filter (optional)',
        type: 'text',
        placeholder: 'your-github-username',
        hint: 'Only items assigned to this login are queued; leave blank for all.'
      },
      { key: 'statusField', label: 'Status field name', type: 'text', placeholder: 'Status' }
    ]
  },
  {
    id: 'shipreq',
    displayName: 'ShipReq',
    blurb:
      'ShipReq (japgolly). ShipReq has no stable public API, so point this at your instance’s HTTP endpoint; the response mapping may need adjustment.',
    fields: [
      { key: 'endpoint', label: 'Base URL', type: 'text', placeholder: 'http://localhost:8080' },
      { key: 'token', label: 'API token', type: 'password' },
      { key: 'project', label: 'Project id / slug', type: 'text' },
      {
        key: 'query',
        label: 'Filter (optional)',
        type: 'text',
        placeholder: 'assigned-to-me open'
      }
    ]
  }
]

export function trackerDescriptor(id: string): TrackerDescriptor | undefined {
  return TRACKERS.find((t) => t.id === id)
}

export function trackerDisplayName(id: string): string {
  return trackerDescriptor(id)?.displayName ?? id
}
