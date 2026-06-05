// Code-forge adapter descriptors. These are pure metadata shared with the
// renderer so the UI can render the active forge's settings fields. The actual
// implementations live in src/main/forges/.
//
// Independent of the project tracker (src/shared/types/trackers.ts): pick any
// combination — e.g. Jira + Azure DevOps, GitHub Projects + GitHub, etc.

export type ForgeFieldType = 'text' | 'textarea' | 'password' | 'number'

export interface ForgeField {
  key: string
  label: string
  type: ForgeFieldType
  placeholder?: string
  hint?: string
}

export interface ForgeDescriptor {
  id: string
  displayName: string
  blurb: string
  /** Settings fields shown when this forge is active. Stored in settings.forgeConfig[id]. */
  fields: ForgeField[]
}

export const FORGES: ForgeDescriptor[] = [
  {
    id: 'github',
    displayName: 'GitHub',
    blurb: 'Uses the gh CLI (which you already auth with for PR discovery / reviews / merges).',
    // The github forge has no per-forge config — username / watch list live
    // in the dedicated "GitHub" section above the Forge selector.
    fields: []
  },
  {
    id: 'azuredevops',
    displayName: 'Azure DevOps',
    blurb:
      'Azure DevOps Repos via the REST API (no `az` CLI required). Auth with a Personal Access Token. Repo names are `{org}/{project}/{repo}`.',
    fields: [
      {
        key: 'org',
        label: 'Organization',
        type: 'text',
        placeholder: 'your-org',
        hint: 'The slug in dev.azure.com/{org}.'
      },
      {
        key: 'project',
        label: 'Default project (optional)',
        type: 'text',
        placeholder: 'YourProject',
        hint:
          'Used when a repo name is just `org/repo` (2 segments). If you always use `org/Project/repo` you can leave this blank.'
      },
      {
        key: 'pat',
        label: 'Personal Access Token',
        type: 'password',
        hint: 'Needs Code (Read & Write) scope. Create at dev.azure.com → User settings → PATs.'
      },
      {
        key: 'reviewerFilter',
        label: 'Reviewer filter (optional)',
        type: 'text',
        placeholder: 'user@example.com',
        hint: 'Identity (email or unique name) to filter review-requested PRs by.'
      }
    ]
  }
]

export function forgeDescriptor(id: string): ForgeDescriptor | undefined {
  return FORGES.find((t) => t.id === id)
}

export function forgeDisplayName(id: string): string {
  return forgeDescriptor(id)?.displayName ?? id
}
