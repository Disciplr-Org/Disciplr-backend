export type MilestoneStatus = 'pending' | 'in_progress' | 'completed' | 'failed'

export interface Milestone {
  id: string
  vault_id: string
  title: string
  description?: string | null
  target_amount: string
  current_amount: string
  deadline: Date | string
  status: MilestoneStatus
  created_at?: Date | string
  updated_at?: Date | string
}

export const TERMINAL_STATUSES: ReadonlySet<MilestoneStatus> = new Set([
  'completed',
  'failed',
] as const)

export const VALID_TRANSITIONS: Readonly<Record<MilestoneStatus, readonly MilestoneStatus[]>> = {
  pending: ['in_progress'],
  in_progress: ['completed', 'failed', 'pending'],
  completed: [],
  failed: [],
}

export interface TransitionResult {
  success: boolean
  error?: string
}
