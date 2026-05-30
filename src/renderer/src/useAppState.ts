import { useEffect, useState } from 'react'
import { api } from './api'
import type { AppState } from '@shared/types/domain'
import type { NotificationPayload } from '@shared/types/ipc'

export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null)

  useEffect(() => {
    let mounted = true
    api.snapshot().then((s) => mounted && setState(s))
    const off = api.onState((s) => setState(s))
    return () => {
      mounted = false
      off()
    }
  }, [])

  return state
}

export function useNotifications(onNotify: (n: NotificationPayload) => void): void {
  useEffect(() => api.onNotification(onNotify), [onNotify])
}
