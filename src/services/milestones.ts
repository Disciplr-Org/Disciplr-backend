export interface Milestone {
  id: string
  vaultId: string
  description: string
  verified: boolean
  verifiedAt: string | null
  verifiedBy: string | null
  verifierId: string | null
  evidenceHash: string | null
  createdAt: string
  /** ISO 8601 UTC timestamp after which check-in requires a grace window. */
  dueDate: string | null
}

const milestonesTable: Milestone[] = []

export const createMilestone = (vaultId: string, description: string, verifierId?: string | null, dueDate?: string | null): Milestone => {
  const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const milestone: Milestone = {
    id,
    vaultId,
    description,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    verifierId: verifierId || null,
    evidenceHash: null,
    createdAt: new Date().toISOString(),
    dueDate: dueDate ?? null,
  }
  milestonesTable.push(milestone)
  return milestone
}

export const getMilestonesByVaultId = (vaultId: string): Milestone[] => {
  return milestonesTable.filter((m) => m.vaultId === vaultId)
}

export const getMilestoneById = (id: string): Milestone | undefined => {
  return milestonesTable.find((m) => m.id === id)
}

export const verifyMilestone = (id: string): Milestone | null => {
  const milestone = milestonesTable.find((m) => m.id === id)
  if (!milestone) return null

  milestone.verified = true
  milestone.verifiedAt = new Date().toISOString()
  return milestone
}

export const validateMilestone = (id: string, validatorUserId: string, evidenceHash: string): { success: boolean, milestone?: Milestone, error?: string } => {
  const milestone = milestonesTable.find((m) => m.id === id)
  if (!milestone) return { success: false, error: 'Milestone not found' }

  if (milestone.verifierId && milestone.verifierId !== validatorUserId) {
    return { success: false, error: 'Unauthorized: only assigned verifier can validate' }
  }

  if (milestone.verified) {
    return { success: false, error: 'Milestone already validated' }
  }

  milestone.verified = true
  milestone.verifiedAt = new Date().toISOString()
  milestone.verifiedBy = validatorUserId
  milestone.evidenceHash = evidenceHash

  // Record validation event
  addMilestoneEvent({
    userId: validatorUserId,
    vaultId: milestone.vaultId,
    name: 'milestone.validated',
    status: 'success',
    timestamp: new Date().toISOString(),
  })

  return { success: true, milestone }
}

export const allMilestonesVerified = (vaultId: string): boolean => {
  const milestones = getMilestonesByVaultId(vaultId)
  if (milestones.length === 0) return false
  return milestones.every((m) => m.verified)
}

export const resetMilestonesTable = (): void => {
  milestonesTable.length = 0
}

// ============================================================================
// Milestone lifecycle state machine (monotonic, auditable, duplicate-safe)
// ============================================================================

/**
 * Explicit milestone lifecycle states. Transitions are monotonic: they may
 * only move forward through this chain, never backwards:
 *
 *   created -> submitted -> validated -> settled
 *
 * - `settled` is terminal (vault completion follows from it; the milestone
 *   itself never regresses).
 * - Rejected/failed outcomes are recorded as events, never as state regressions.
 * - Every successful transition emits exactly one ordered lifecycle event.
 */
export type MilestoneLifecycleState = 'created' | 'submitted' | 'validated' | 'settled'

const LIFECYCLE_ORDER: Record<MilestoneLifecycleState, number> = {
  created: 0,
  submitted: 1,
  validated: 2,
  settled: 3,
}

export const LIFECYCLE_TRANSITIONS: Record<MilestoneLifecycleState, MilestoneLifecycleState[]> = {
  created: ['submitted'],
  submitted: ['validated'],
  validated: ['settled'],
  settled: [],
}

/** Per-milestone lifecycle state, mirrored onto the milestone record. */
const lifecycleState: Record<string, MilestoneLifecycleState> = {}
/** Monotonic sequence number per milestone; also the global event sequence key. */
const lifecycleSeq: Record<string, number> = {}
/** Idempotency keys already applied, per milestone (duplicate-request safety). */
const appliedIdempotencyKeys: Record<string, Set<string>> = {}

export const getMilestoneLifecycleState = (id: string): MilestoneLifecycleState | null =>
  lifecycleState[id] ?? null

export const resetMilestoneLifecycle = (): void => {
  for (const key of Object.keys(lifecycleState)) delete lifecycleState[key]
  for (const key of Object.keys(lifecycleSeq)) delete lifecycleSeq[key]
  for (const key of Object.keys(appliedIdempotencyKeys)) delete appliedIdempotencyKeys[key]
}

/**
 * Advance a milestone's lifecycle state through an allowed forward transition.
 *
 * Invariants enforced here:
 * - Monotonicity: target rank must be strictly greater than current rank;
 *   any backwards or self transition is rejected with `regression`.
 * - Unknown states and unknown milestones are rejected.
 * - On success, `milestone.verified`/`verifiedAt` are advanced atomically with
 *   the state change and exactly one ordered lifecycle event is emitted.
 */
export const transitionMilestone = (
  id: string,
  to: MilestoneLifecycleState,
  opts?: { idempotencyKey?: string; actor?: string; at?: string },
): { success: boolean; milestone?: Milestone; from?: MilestoneLifecycleState; to?: MilestoneLifecycleState; error?: string } => {
  const milestone = milestonesTable.find((m) => m.id === id)
  if (!milestone) return { success: false, error: 'Milestone not found' }

  if (!(to in LIFECYCLE_ORDER)) return { success: false, error: `Unknown lifecycle state: ${String(to)}` }

  const from: MilestoneLifecycleState = lifecycleState[id] ?? 'created'

  // Duplicate-request safety: the same idempotency key may only apply once
  // per milestone. A retry with the same key is acknowledged without
  // re-applying the transition (exactly-once semantics). Checked before the
  // monotonicity guards so a replay of an already-applied transition is
  // acknowledged as a duplicate rather than misreported as a regression.
  const idem = opts?.idempotencyKey
  if (idem !== undefined && appliedIdempotencyKeys[id]?.has(idem)) {
    return { success: true, milestone, from, to, error: 'duplicate-idempotent-replay' }
  }

  if (from === 'settled') {
    return { success: false, error: 'Milestone already settled', milestone, from, to }
  }
  if (LIFECYCLE_ORDER[to] <= LIFECYCLE_ORDER[from]) {
    return { success: false, error: 'Lifecycle regression: cannot move backwards', milestone, from, to }
  }
  if (!LIFECYCLE_TRANSITIONS[from].includes(to)) {
    return { success: false, error: `Invalid transition: ${from} -> ${to}`, milestone, from, to }
  }

  if (idem !== undefined) {
    if (!appliedIdempotencyKeys[id]) appliedIdempotencyKeys[id] = new Set()
    appliedIdempotencyKeys[id].add(idem)
  }

  lifecycleState[id] = to
  if (lifecycleSeq[id] === undefined) lifecycleSeq[id] = 0
  lifecycleSeq[id] += 1

  if (to === 'validated' || to === 'settled') {
    milestone.verified = true
    milestone.verifiedAt = opts?.at ?? new Date().toISOString()
    milestone.verifiedBy = opts?.actor ?? milestone.verifiedBy
  }

  addMilestoneEvent({
    userId: opts?.actor ?? 'system',
    vaultId: milestone.vaultId,
    name: `milestone.lifecycle.${to}`,
    status: 'success',
    timestamp: opts?.at ?? new Date().toISOString(),
  })

  return { success: true, milestone, from, to }
}

/**
 * Global monotonic sequence number for a milestone's lifecycle events.
 * Every successful transition increments it; never resets while the process lives.
 */
export const getMilestoneEventSeq = (id: string): number => lifecycleSeq[id] ?? 0

// ============================================================================
// Ordered, auditable milestone event ledger
// ============================================================================

export type MilestoneStatus = 'success' | 'failed'
export interface MilestoneEvent {
  id: string
  userId: string
  vaultId: string
  name: string
  status: MilestoneStatus
  timestamp: string
}

let milestones: MilestoneEvent[] = []

export const resetMilestones = (): void => {
  milestones = []
}

/**
 * Append a milestone event to the audit ledger.
 *
 * Invariants:
 * - Append-only: events are never mutated or removed.
 * - Ordered: each event gets a monotonically increasing per-milestone sequence
 *   number embedded in its id (`m_<seq>_...`), so ledger order is auditable
 *   and survives equal timestamps.
 * - Duplicate-safe: the same (userId, vaultId, name, timestamp) tuple is
 *   acknowledged by returning the already-recorded event instead of
 *   appending a second copy (exactly-once under duplicate requests).
 */
export const addMilestoneEvent = (event: Omit<MilestoneEvent, 'id'>): MilestoneEvent => {
  const dup = milestones.find(
    (e) =>
      e.userId === event.userId &&
      e.vaultId === event.vaultId &&
      e.name === event.name &&
      e.timestamp === event.timestamp,
  )
  if (dup) return dup

  if (!lifecycleSeq[event.vaultId]) lifecycleSeq[event.vaultId] = 0
  lifecycleSeq[event.vaultId] += 1
  const seq = lifecycleSeq[event.vaultId]
  const id = `m_${seq}_${Math.random().toString(36).slice(2, 9)}`
  const record: MilestoneEvent = { id, ...event }
  milestones.push(record)
  return record
}

export const listMilestoneEvents = (opts?: {
  userId?: string
  vaultId?: string
  from?: string
  to?: string
}): MilestoneEvent[] => {
  let result = [...milestones]
  if (opts?.userId) result = result.filter((e) => e.userId === opts.userId)
  if (opts?.vaultId) result = result.filter((e) => e.vaultId === opts.vaultId)
  if (opts?.from) {
    const fromTs = new Date(opts.from).getTime()
    result = result.filter((e) => new Date(e.timestamp).getTime() >= fromTs)
  }
  if (opts?.to) {
    const toTs = new Date(opts.to).getTime()
    result = result.filter((e) => new Date(e.timestamp).getTime() <= toTs)
  }
  return result
}

// ============================================================================
// Multi-Verifier Threshold Support for Milestones
// ============================================================================

/**
 * Extended Milestone interface with multi-verifier threshold support.
 */
export interface MilestoneWithThreshold {
  id: string
  vaultId: string
  description: string
  verifierId: string | null
  approvalThreshold: number // M in M-of-N threshold
  verified: boolean
  verifiedAt: string | null
  verifiedBy: string | null
  createdAt: string
}

/**
 * Milestone approval status for threshold-based validation.
 */
export interface MilestoneApprovalStatus {
  milestoneId: string
  approvalThreshold: number
  approvedCount: number
  rejectedCount: number
  pendingCount: number
  isComplete: boolean
  isRejected: boolean
  approvalPercentage: number
}

/**
 * Create a milestone with multi-verifier approval threshold.
 * Threshold determines how many verifiers need to approve before milestone is considered verified.
 */
export const createMilestoneWithThreshold = (
  vaultId: string,
  description: string,
  approvalThreshold: number = 1,
  verifierId?: string | null,
): MilestoneWithThreshold => {
  const id = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const milestone: MilestoneWithThreshold = {
    id,
    vaultId,
    description,
    verifierId: verifierId || null,
    approvalThreshold,
    verified: false,
    verifiedAt: null,
    verifiedBy: null,
    createdAt: new Date().toISOString(),
  }
  milestonesTable.push(milestone as any)
  return milestone
}

/**
 * Get milestone as MilestoneWithThreshold if it exists.
 */
export const getMilestoneByIdWithThreshold = (id: string): MilestoneWithThreshold | undefined => {
  const milestone = milestonesTable.find((m) => m.id === id)
  if (!milestone) return undefined

  return {
    id: milestone.id,
    vaultId: milestone.vaultId,
    description: milestone.description,
    verifierId: milestone.verifierId || null,
    approvalThreshold: (milestone as any).approvalThreshold || 1,
    verified: milestone.verified,
    verifiedAt: milestone.verifiedAt,
    verifiedBy: milestone.verifiedBy,
    createdAt: milestone.createdAt,
  }
}

/**
 * Get milestones from vault filtered by threshold requirement.
 */
export const getMilestonesByVaultIdWithThreshold = (
  vaultId: string,
  minThreshold?: number,
): MilestoneWithThreshold[] => {
  return milestonesTable
    .filter((m) => m.vaultId === vaultId)
    .map((m) => ({
      id: m.id,
      vaultId: m.vaultId,
      description: m.description,
      verifierId: m.verifierId || null,
      approvalThreshold: (m as any).approvalThreshold || 1,
      verified: m.verified,
      verifiedAt: m.verifiedAt,
      verifiedBy: m.verifiedBy,
      createdAt: m.createdAt,
    }))
    .filter((m) => (minThreshold === undefined ? true : m.approvalThreshold >= minThreshold))
}

/**
 * Validate that a milestone requires M-of-N approval and hasn't been approved yet by this verifier.
 * Rejects suspended/deactivated verifiers from casting new votes while preserving historical votes.
 * Returns validation result with details.
 */
export const validateMilestoneMultiVerifier = (
  id: string,
  validatorUserId: string,
  verifierStatus?: string,
): {
  success: boolean
  milestone?: MilestoneWithThreshold
  error?: string
  canApprove?: boolean
} => {
  const milestone = getMilestoneByIdWithThreshold(id)
  if (!milestone) {
    return { success: false, error: 'Milestone not found', canApprove: false }
  }

  if (verifierStatus === 'suspended' || verifierStatus === 'deactivated') {
    return {
      success: false,
      error: 'Suspended/deactivated verifier cannot cast milestone approvals',
      milestone,
      canApprove: false,
    }
  }

  // For thresholds > 1, multiple verifiers should be able to approve
  if (milestone.approvalThreshold === 1 && milestone.verifierId && milestone.verifierId !== validatorUserId) {
    return {
      success: false,
      error: 'Unauthorized: only assigned verifier can validate this milestone',
      milestone,
      canApprove: false,
    }
  }

  if (milestone.verified) {
    return {
      success: false,
      error: 'Milestone already verified',
      milestone,
      canApprove: false,
    }
  }

  return { success: true, milestone, canApprove: true }
}

/**
 * Check if all milestones in a vault meet their approval threshold,
 * taking into account veto-by-rejection semantics.
 *
 * A milestone is settled (not-vetoed + threshold met) when:
 *   approved >= threshold  AND  maxPossibleApprovals >= threshold
 *
 * where maxPossibleApprovals = approved + (totalVerifiers - totalVoted).
 * If totalVerifiers is absent for a milestone, any rejection is treated as a veto.
 */
export const allMilestonesMetThreshold = (
  vaultId: string,
  approvalCounts: Record<string, number>,
  rejectionCounts: Record<string, number> = {},
  totalVerifierCounts: Record<string, number> = {},
): boolean => {
  const vaultMilestones = getMilestonesByVaultId(vaultId)
  if (vaultMilestones.length === 0) return false

  return vaultMilestones.every((m) => {
    const threshold = (m as any).approvalThreshold || 1
    const approved = approvalCounts[m.id] || 0
    const rejected = rejectionCounts[m.id] || 0
    const n = totalVerifierCounts[m.id]

    if (n !== undefined && n > 0) {
      const totalVoted = approved + rejected
      const remaining = Math.max(n - totalVoted, 0)
      const maxPossible = approved + remaining
      if (maxPossible < threshold) return false // veto: can never reach threshold
    } else {
      if (rejected > 0) return false // legacy: any rejection vetoes
    }

    return approved >= threshold
  })
}
