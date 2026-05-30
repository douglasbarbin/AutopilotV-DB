import { Notification } from 'electron'
import { EventEmitter } from 'events'
import { getSettings } from './store'
import { log } from './log'
import type { NotificationPayload } from '@shared/types/ipc'

class Notifier extends EventEmitter {
  notify(payload: NotificationPayload): void {
    const s = getSettings().notifications
    const enabled =
      (payload.kind === 'review_ready' && s.reviewReady) ||
      (payload.kind === 'needs_human' && s.needsHuman) ||
      (payload.kind === 'pr_ready_to_merge' && s.prReadyToMerge)
    if (!enabled) return

    // Forward to renderer (in-app toast + deep link).
    this.emit('notification', payload)

    // OS notification.
    if (Notification.isSupported()) {
      const n = new Notification({ title: payload.title, body: payload.body })
      n.on('click', () => this.emit('notification-click', payload))
      n.show()
    } else {
      log.info('OS notifications unsupported', { kind: payload.kind })
    }
  }
}

export const notifier = new Notifier()
