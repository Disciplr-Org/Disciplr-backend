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

export const addMilestoneEvent = (event: Omit<MilestoneEvent, 'id'>): MilestoneEvent => {
  const id = `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
 * Returns validation result with details.
 */
export const validateMilestoneMultiVerifier = (
  id: string,
  validatorUserId: string,
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
 * Check if all milestones in a vault meet their approval thresholds.
 */
export const allMilestonesMetThreshold = (vaultId: string, approvalCounts: Record<string, number>): boolean => {
  const vaultMilestones = getMilestonesByVaultId(vaultId)
  if (vaultMilestones.length === 0) return false

  return vaultMilestones.every((m) => {
    const threshold = (m as any).approvalThreshold || 1
    const approvals = approvalCounts[m.id] || 0
    return approvals >= threshold
  })
}
