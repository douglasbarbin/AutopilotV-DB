import type { DevPhase, IntegrationStatus, TaskStatus } from '@shared/types/domain'

export interface ColorToken {
  label: string
  color: string
}

export const PHASE_META: Record<DevPhase, ColorToken> = {
  unclaimed: { label: 'Unclaimed', color: 'var(--comment)' },
  implementing: { label: 'Implementing', color: 'var(--blue)' },
  draft: { label: 'Draft', color: 'var(--yellow)' },
  revising: { label: 'Revising', color: 'var(--orange)' },
  in_review: { label: 'In Review', color: 'var(--purple)' },
  ready_to_merge: { label: 'Ready to merge', color: 'var(--green)' },
  done: { label: 'Done', color: 'var(--green)' },
  error: { label: 'Error', color: 'var(--red)' }
}

export const STATUS_META: Record<TaskStatus, ColorToken> = {
  todo: { label: 'To Do', color: 'var(--comment)' },
  in_progress: { label: 'In Progress', color: 'var(--blue)' },
  in_review: { label: 'In Review', color: 'var(--purple)' },
  ready_to_merge: { label: 'Ready to merge', color: 'var(--green)' },
  done: { label: 'Done', color: 'var(--green)' }
}

export const TYPE_COLOR: Record<string, string> = {
  Story: 'var(--green)',
  Bug: 'var(--red)',
  Task: 'var(--blue)',
  'Sub-task': 'var(--aqua)',
  Improvement: 'var(--purple)'
}

export const INTEGRATION_STATUS_COLOR: Record<IntegrationStatus, string> = {
  ok: 'var(--green)',
  degraded: 'var(--yellow)',
  down: 'var(--red)',
  unknown: 'var(--comment)'
}

/**
 * Display label/color for a dev task. While unclaimed, mirror the real tracker
 * status (so users see the same column the tracker shows); once AutopilotV
 * starts driving the task, surface the orchestrator's own phase instead.
 */
export function taskStateLabel(
  driving: boolean,
  phase: DevPhase,
  trackerStatus: string,
  status: TaskStatus
): ColorToken {
  if (!driving) return { label: trackerStatus || STATUS_META[status].label, color: STATUS_META[status].color }
  return PHASE_META[phase]
}
