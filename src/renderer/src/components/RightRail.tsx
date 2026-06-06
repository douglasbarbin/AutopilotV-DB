import type { ReactNode } from 'react'
import { Icon } from './Icon'

export interface RailAction {
  id: string
  label: string
  icon: Parameters<typeof Icon>[0]['name']
  onClick: () => void
  /** Optional element rendered below the icon (e.g. a small badge). */
  badge?: ReactNode
  disabled?: boolean
}

export function RightRail({ actions }: { actions: RailAction[] }) {
  return (
    <aside className="right-rail" aria-label="Quick actions">
      {actions.map((a) => (
        <button
          key={a.id}
          className="rail-btn"
          onClick={a.onClick}
          title={a.label}
          aria-label={a.label}
          disabled={a.disabled}
        >
          <Icon name={a.icon} size={18} />
          {a.badge}
        </button>
      ))}
    </aside>
  )
}
