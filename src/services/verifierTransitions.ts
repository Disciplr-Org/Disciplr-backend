/**
 * Shared authorization boundary for verifier queue actions.
 *
 * A verifier is allowed to change a queue item only when the item is still
 * assigned to that verifier.  Multi-verifier milestones are the deliberate
 * exception: their threshold is greater than one and the assignment denotes
 * the queue's coordinating verifier, while the approved verifier pool may
 * cast the individual votes.
 *
 * Keeping this decision in one small, side-effect-free module is important.
 * HTTP routes, background consumers, and future GraphQL mutations must not
 * each grow subtly different stale-assignment rules.
 */

export type VerifierQueueAction = 'verify' | 'validate' | 'approve'

export interface VerifierQueueItem {
  id: string
  verifierId?: string | null
  approvalThreshold?: number
  verified?: boolean
}

export type VerifierAuthorizationCode =
  | 'ACTOR_REQUIRED'
  | 'UNASSIGNED_QUEUE_ITEM'
  | 'STALE_ASSIGNMENT'
  | 'ALREADY_SETTLED'
  | 'INVALID_TRANSITION'

export class VerifierAuthorizationError extends Error {
  readonly code: VerifierAuthorizationCode
  readonly action: VerifierQueueAction
  readonly itemId: string

  constructor(
    code: VerifierAuthorizationCode,
    action: VerifierQueueAction,
    itemId: string,
    message: string,
  ) {
    super(message)
    this.name = 'VerifierAuthorizationError'
    this.code = code
    this.action = action
    this.itemId = itemId
  }
}

const thresholdFor = (item: VerifierQueueItem): number => {
  const threshold = Number(item.approvalThreshold ?? 1)
  return Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 1
}

/**
 * Assert that an authenticated verifier may perform the requested action.
 * This function intentionally performs no mutation, so callers can invoke it
 * before a transaction or before changing an in-memory compatibility record.
 */
export const authorizeVerifierQueueAction = (
  item: VerifierQueueItem,
  actorUserId: unknown,
  action: VerifierQueueAction,
): void => {
  if (typeof actorUserId !== 'string' || actorUserId.trim() === '') {
    throw new VerifierAuthorizationError(
      'ACTOR_REQUIRED',
      action,
      item.id,
      'Authentication required for verifier queue action',
    )
  }

  if (item.verified === true && action !== 'approve') {
    throw new VerifierAuthorizationError(
      'ALREADY_SETTLED',
      action,
      item.id,
      'Milestone is already settled',
    )
  }

  // An M-of-N approval queue is intentionally shared by its approved pool.
  // Single-verifier validation and verification always require an exact,
  // current assignment, including after an administrator reassigns the item.
  const multiVerifierApproval = action === 'approve' && thresholdFor(item) > 1
  if (multiVerifierApproval) return

  if (typeof item.verifierId !== 'string' || item.verifierId.trim() === '') {
    throw new VerifierAuthorizationError(
      'UNASSIGNED_QUEUE_ITEM',
      action,
      item.id,
      'Verifier queue item is not assigned to an active verifier',
    )
  }

  if (item.verifierId !== actorUserId.trim()) {
    throw new VerifierAuthorizationError(
      'STALE_ASSIGNMENT',
      action,
      item.id,
      'Unauthorized: only the currently assigned verifier can perform this action',
    )
  }
}

/**
 * Validate a monotonic state change before the persistence layer runs it.
 * The route still owns the concrete state transition; this helper makes the
 * allowed transition contract explicit and testable for every caller.
 */
export const assertVerifierLifecycleTransition = (
  item: VerifierQueueItem,
  actorUserId: unknown,
  action: VerifierQueueAction,
  from: 'created' | 'submitted' | 'validated' | 'settled',
  to: 'submitted' | 'validated' | 'settled',
): void => {
  authorizeVerifierQueueAction(item, actorUserId, action)

  const allowed: Record<string, string[]> = {
    created: ['submitted'],
    submitted: ['validated'],
    validated: ['settled'],
    settled: [],
  }

  if (!allowed[from]?.includes(to)) {
    throw new VerifierAuthorizationError(
      'INVALID_TRANSITION',
      action,
      item.id,
      `Invalid verifier lifecycle transition: ${from} -> ${to}`,
    )
  }
}

