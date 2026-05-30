import type { AutopilotVApi } from '@shared/types/ipc'

declare global {
  interface Window {
    autopilotv: AutopilotVApi
  }
}

export const api = window.autopilotv
