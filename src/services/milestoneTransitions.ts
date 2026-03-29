import {
  type MilestoneStatus,
  type TransitionResult,
  VALID_TRANSITIONS,
  TERMINAL_STATUSES,
} from '../types/milestone.js'

/**
 * Returns a human-readable error string if the transition is invalid, or null if it is valid.
 */
export const getTransitionError = (
  currentStatus: MilestoneStatus,
  targetStatus: MilestoneStatus,
): string | null => {
  if (TERMINAL_STATUSES.has(currentStatus)) {
    return `Milestone is already '${currentStatus}' and cannot transition`
  }

  const allowed = VALID_TRANSITIONS[currentStatus]
  if (!allowed) {
    return `Unknown current status: '${currentStatus}'`
  }

  if (!allowed.includes(targetStatus)) {
    return `Cannot transition from '${currentStatus}' to '${targetStatus}'`
  }

  return null
}

/**
 * Validates and returns a TransitionResult for the given status change.
 */
export const validateTransition = (
  currentStatus: MilestoneStatus,
  targetStatus: MilestoneStatus,
): TransitionResult => {
  const error = getTransitionError(currentStatus, targetStatus)
  if (error) return { success: false, error }
  return { success: true }
}
