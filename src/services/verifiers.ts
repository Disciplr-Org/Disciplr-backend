import { createAuditLog, AuditLog } from '../lib/audit-logs.js'
import { db } from '../db/knex.js'
import type { Knex } from 'knex'

export type VerifierStatus = 'pending' | 'approved' | 'suspended' | 'deactivated'
export type VerificationResult = 'approved' | 'rejected'

export class VerificationConflictError extends Error {
  constructor() {
    super('conflict: decision already made')
    this.name = 'VerificationConflictError'
  }
}

export interface VerifierProfile {
  userId: string
  displayName?: string | null
  metadata?: Record<string, unknown> | null
  status: VerifierStatus
  createdAt: string
  approvedAt?: string | null
  suspendedAt?: string | null
  deactivatedAt?: string | null
}

export interface VerificationRecord {
  id: string
  verifierUserId: string
  targetId: string
  result: VerificationResult
  evidenceHash: string | null
  disputed: boolean
  timestamp: string
}

export type VerifierMutationContext = {
  actorUserId: string
  reason?: string
}

export type VerifierMutationResult = {
  before: VerifierProfile | null
  after: VerifierProfile
  changedFields: string[]
  auditLog: AuditLog | null
}

const transitionMatrix: Record<VerifierStatus, VerifierStatus[]> = {
  pending: ['pending', 'approved', 'deactivated'],
  approved: ['approved', 'suspended', 'deactivated'],
  suspended: ['suspended', 'approved', 'deactivated'],
  deactivated: ['deactivated', 'pending'],
}

export const canTransition = (from: VerifierStatus, to: VerifierStatus): boolean =>
  transitionMatrix[from]?.includes(to) === true

export const createVerifierProfile = async (
  userId: string,
  opts: { displayName?: string; metadata?: Record<string, unknown>; status?: VerifierStatus } | undefined,
  context: VerifierMutationContext,
): Promise<VerifierMutationResult> => {
  return db.transaction(async (trx) => {
    const status = opts?.status ?? 'pending'
    const [inserted] = await trx('verifiers')
      .insert({
        user_id: userId,
        display_name: opts?.displayName ?? null,
        metadata: opts?.metadata ?? null,
        ...mapStatusToUpdates(status),
      })
      .returning('*')

    const after = mapVerifierRow(inserted)
    const changedFields = ['user_id', 'status']
    if (opts?.displayName !== undefined) changedFields.push('display_name')
    if (opts?.metadata !== undefined) changedFields.push('metadata')

    const auditLog = await createVerifierAuditLog({
      action: 'verifier.created',
      context,
      targetId: after.userId,
      before: null,
      after,
      changedFields,
    })

    return { before: null, after, changedFields, auditLog }
  })
}

export const createOrGetVerifierProfile = async (
  userId: string,
  opts: { displayName?: string; metadata?: Record<string, unknown> } | undefined,
  context: VerifierMutationContext,
) => {
  const existing = await db('verifiers').where({ user_id: userId }).first()
  if (existing) return mapVerifierRow(existing)

  return (await createVerifierProfile(userId, opts, context)).after
}

export const updateVerifierProfile = async (
  userId: string,
  updates: { displayName?: string | null; metadata?: Record<string, unknown> | null; status?: VerifierStatus },
  context: VerifierMutationContext,
): Promise<VerifierMutationResult | null> => {
  return db.transaction(async (trx) => {
    const current = await trx('verifiers').where({ user_id: userId }).first()
    if (!current) return null

    const before = mapVerifierRow(current)
    const patch: Record<string, unknown> = {}
    if (updates.displayName !== undefined) patch.display_name = updates.displayName
    if (updates.metadata !== undefined) patch.metadata = updates.metadata

    if (updates.status !== undefined) {
      if (!canTransition(before.status, updates.status)) {
        throw new InvalidVerifierStatusTransitionError(before.status, updates.status)
      }
      Object.assign(patch, mapStatusToUpdates(updates.status))
    }

    const changedFields = getChangedFields(before, updates)
    if (changedFields.length === 0) {
      return { before, after: before, changedFields, auditLog: null }
    }

    const [updated] = await trx('verifiers').where({ user_id: userId }).update(patch).returning('*')
    const after = mapVerifierRow(updated)
    const action = updates.status !== undefined && before.status !== after.status
      ? statusAction(before.status, after.status)
      : 'verifier.updated'

    if (!action) {
      throw new Error(`Missing verifier audit action for ${before.status} -> ${after.status}`)
    }

    const auditLog = await createVerifierAuditLog({
      action,
      context,
      targetId: userId,
      before,
      after,
      changedFields,
    })

    return { before, after, changedFields, auditLog }
  })
}

export const transitionVerifier = async (
  userId: string,
  status: VerifierStatus,
  context: VerifierMutationContext,
): Promise<VerifierMutationResult | null> =>
  updateVerifierProfile(userId, { status }, context)

export const deleteVerifierProfile = async (
  userId: string,
  context: VerifierMutationContext,
): Promise<{ deleted: boolean; before: VerifierProfile | null; auditLog: AuditLog | null }> => {
  return db.transaction(async (trx) => {
    const current = await trx('verifiers').where({ user_id: userId }).first()
    if (!current) return { deleted: false, before: null, auditLog: null }

    const before = mapVerifierRow(current)
    const deletedCount = await trx('verifiers').where({ user_id: userId }).del()
    if (deletedCount === 0) return { deleted: false, before, auditLog: null }

    const auditLog = await createVerifierAuditLog({
      action: 'verifier.deleted',
      context,
      targetId: userId,
      before,
      after: null,
      changedFields: ['deleted'],
    })

    return { deleted: true, before, auditLog }
  })
}

export const getVerifierProfile = async (userId: string): Promise<VerifierProfile | undefined> => {
  const row = await db('verifiers').where({ user_id: userId }).first()
  if (!row) return undefined
  return mapVerifierRow(row)
}

export const listVerifierProfiles = async (): Promise<VerifierProfile[]> => {
  const rows = await db('verifiers').select('*').orderBy('created_at', 'desc')
  return rows.map(mapVerifierRow)
}

export const setVerifierStatus = async (
  userId: string,
  status: VerifierStatus,
): Promise<VerifierProfile | null> => {
  const row = await db('verifiers').where({ user_id: userId }).first()
  if (!row) return null

  const [updated] = await db('verifiers').where({ user_id: userId }).update(mapStatusToUpdates(status)).returning('*')
  return mapVerifierRow(updated)
}

export const recordVerification = async (
  verifierUserId: string,
  targetId: string,
  result: VerificationResult,
  disputed = false,
  evidenceHash?: string,
  trx?: Knex.Transaction,
): Promise<VerificationRecord> => {
  const client = trx ?? db
  const existing = await client('verifications')
    .where({
      verifier_user_id: verifierUserId,
      target_id: targetId,
    })
    .first()

  if (existing) {
    if (existing.result === result) {
      return mapVerificationRow(existing)
    }

    throw new VerificationConflictError()
  }

  const [rec] = await client('verifications')
    .insert({
      verifier_user_id: verifierUserId,
      target_id: targetId,
      result,
      disputed,
      evidence_hash: evidenceHash ?? null,
    })
    .returning('*')

  return mapVerificationRow(rec)
}

export const listVerifications = async (): Promise<VerificationRecord[]> => {
  const rows = await db('verifications').select('*').orderBy('timestamp', 'desc')
  return rows.map(mapVerificationRow)
}

export const getVerifierStats = async (userId: string) => {
  const totalQ = db('verifications').where({ verifier_user_id: userId }).count<{ count: string }>('id as count').first()
  const approvalsQ = db('verifications').where({ verifier_user_id: userId, result: 'approved' }).count<{ count: string }>('id as count').first()
  const rejectionsQ = db('verifications').where({ verifier_user_id: userId, result: 'rejected' }).count<{ count: string }>('id as count').first()
  const disputesQ = db('verifications').where({ verifier_user_id: userId, disputed: true }).count<{ count: string }>('id as count').first()

  const [totalR, approvalsR, rejectionsR, disputesR] = await Promise.all([totalQ, approvalsQ, rejectionsQ, disputesQ])

  const total = Number(totalR?.count ?? 0)
  const approvals = Number(approvalsR?.count ?? 0)
  const rejections = Number(rejectionsR?.count ?? 0)
  const disputes = Number(disputesR?.count ?? 0)

  const approvalRatio = total === 0 ? 0 : approvals / total
  const rejectionRatio = total === 0 ? 0 : rejections / total
  const disputeRate = total === 0 ? 0 : disputes / total

  return {
    totalVerifications: total,
    approvals,
    rejections,
    disputes,
    approvalRatio,
    rejectionRatio,
    disputeRate,
  }
}

export const resetVerifiers = async (): Promise<void> => {
  await db('verifications').del()
  await db('verifiers').del()
}

export class InvalidVerifierStatusTransitionError extends Error {
  constructor(public readonly from: VerifierStatus, public readonly to: VerifierStatus) {
    super(`Invalid verifier status transition: ${from} -> ${to}`)
    this.name = 'InvalidVerifierStatusTransitionError'
  }
}

function getChangedFields(
  before: VerifierProfile,
  updates: { displayName?: string | null; metadata?: Record<string, unknown> | null; status?: VerifierStatus },
): string[] {
  const changedFields: string[] = []
  if (updates.displayName !== undefined && before.displayName !== updates.displayName) changedFields.push('display_name')
  if (updates.metadata !== undefined && JSON.stringify(before.metadata ?? null) !== JSON.stringify(updates.metadata ?? null)) changedFields.push('metadata')
  if (updates.status !== undefined && before.status !== updates.status) changedFields.push('status')
  return changedFields
}

function createVerifierAuditLog(input: {
  action: string
  context: VerifierMutationContext
  targetId: string
  before: VerifierProfile | null
  after: VerifierProfile | null
  changedFields: string[]
}): Promise<AuditLog> {
  return createAuditLog({
    actor_user_id: input.context.actorUserId,
    action: input.action,
    target_type: 'verifier',
    target_id: input.targetId,
    metadata: {
      before: input.before,
      after: input.after,
      changed_fields: input.changedFields,
      ...(input.context.reason ? { reason: input.context.reason } : {}),
    },
  })
}

function statusAction(from: VerifierStatus | null, to: VerifierStatus): string | null {
  if (from === to) return null
  if (to === 'approved') return 'verifier.approved'
  if (to === 'suspended') return 'verifier.suspended'
  if (to === 'deactivated') return 'verifier.deactivated'
  if (from === 'deactivated' && to === 'pending') return 'verifier.reactivated'
  return null
}

function mapStatusToUpdates(status: VerifierStatus): Record<string, unknown> {
  if (status === 'approved') {
    return {
      status,
      approved_at: db.fn.now(),
      suspended_at: null,
      deactivated_at: null,
    }
  }

  if (status === 'suspended') {
    return {
      status,
      suspended_at: db.fn.now(),
    }
  }

  if (status === 'deactivated') {
    return {
      status,
      deactivated_at: db.fn.now(),
    }
  }

  return {
    status,
    approved_at: null,
    suspended_at: null,
    deactivated_at: null,
  }
}

function mapVerifierRow(row: any): VerifierProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name ?? null,
    metadata: row.metadata ?? null,
    status: row.status,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    approvedAt: row.approved_at?.toISOString?.() ?? row.approved_at,
    suspendedAt: row.suspended_at?.toISOString?.() ?? row.suspended_at,
    deactivatedAt: row.deactivated_at?.toISOString?.() ?? row.deactivated_at,
  }
}

function mapVerificationRow(row: any): VerificationRecord {
  return {
    id: row.id,
    verifierUserId: row.verifier_user_id,
    targetId: row.target_id,
    result: row.result,
    evidenceHash: row.evidence_hash ?? null,
    disputed: !!row.disputed,
    timestamp: row.timestamp?.toISOString?.() ?? row.timestamp,
  }
}

// ============================================================================
// Multi-Verifier Milestone Approval Functions
// ============================================================================

export type MilestoneApprovalStatus = 'pending' | 'approved' | 'rejected'

export interface MilestoneApproval {
  id: string
  milestoneId: string
  verifierUserId: string
  approvalStatus: MilestoneApprovalStatus
  createdAt: string
  updatedAt: string
}

export class DuplicateVerifierVoteError extends Error {
  constructor(milestoneId: string, verifierUserId: string) {
    super(`Verifier ${verifierUserId} has already voted on milestone ${milestoneId}`)
    this.name = 'DuplicateVerifierVoteError'
  }
}

/**
 * Record a milestone approval vote from a verifier.
 * Throws DuplicateVerifierVoteError if verifier has already voted.
 */
export const recordMilestoneApproval = async (
  milestoneId: string,
  verifierUserId: string,
  approvalStatus: MilestoneApprovalStatus,
): Promise<MilestoneApproval> => {
  // Check if verifier has already voted
  const existing = await db('milestone_approvals')
    .where({
      milestone_id: milestoneId,
      verifier_user_id: verifierUserId,
    })
    .first()

  if (existing) {
    throw new DuplicateVerifierVoteError(milestoneId, verifierUserId)
  }

  const [record] = await db('milestone_approvals')
    .insert({
      milestone_id: milestoneId,
      verifier_user_id: verifierUserId,
      approval_status: approvalStatus,
    })
    .returning('*')

  return mapMilestoneApprovalRow(record)
}

/**
 * Get all approvals for a milestone, grouped by approval status.
 */
export const getMilestoneApprovals = async (
  milestoneId: string,
): Promise<{
  approved: MilestoneApproval[]
  rejected: MilestoneApproval[]
  pending: MilestoneApproval[]
}> => {
  const rows = await db('milestone_approvals')
    .where({ milestone_id: milestoneId })
    .orderBy('created_at', 'asc')

  const grouped = {
    approved: [] as MilestoneApproval[],
    rejected: [] as MilestoneApproval[],
    pending: [] as MilestoneApproval[],
  }

  rows.forEach((row) => {
    const mapped = mapMilestoneApprovalRow(row)
    grouped[row.approval_status].push(mapped)
  })

  return grouped
}

/**
 * Get count of approved verifiers for a milestone.
 */
export const getApprovedVerifiersCount = async (milestoneId: string): Promise<number> => {
  const result = await db('milestone_approvals')
    .where({
      milestone_id: milestoneId,
      approval_status: 'approved',
    })
    .count<{ count: string }>('id as count')
    .first()

  return Number(result?.count ?? 0)
}

/**
 * Get all distinct verifier votes for a milestone.
 */
export const getAllMilestoneVotes = async (milestoneId: string): Promise<MilestoneApproval[]> => {
  const rows = await db('milestone_approvals')
    .where({ milestone_id: milestoneId })
    .orderBy('created_at', 'asc')

  return rows.map(mapMilestoneApprovalRow)
}

/**
 * Check if a verifier has already voted on a milestone.
 */
export const hasVerifierVoted = async (
  milestoneId: string,
  verifierUserId: string,
): Promise<boolean> => {
  const record = await db('milestone_approvals')
    .where({
      milestone_id: milestoneId,
      verifier_user_id: verifierUserId,
    })
    .first()

  return !!record
}

/**
 * Check if a milestone has met its approval threshold.
 */
export const hasMilestoneMetThreshold = async (
  milestoneId: string,
  approvalThreshold: number,
): Promise<boolean> => {
  const approvedCount = await getApprovedVerifiersCount(milestoneId)
  return approvedCount >= approvalThreshold
}

/**
 * Get approval progress for a milestone (X of Y approvals).
 *
 * Veto math (when totalVerifiers N is provided):
 *   A milestone is irrevocably rejected once it is impossible for approvals
 *   to ever reach the threshold M:
 *     isRejected = (approved + remaining) < M
 *   where remaining = N - totalVoted.
 *
 *   Equivalently: rejected > N - M  (more rejections than the veto budget).
 *
 * When totalVerifiers is omitted (legacy / N unknown), any single rejection
 * marks the milestone rejected (conservative default).
 */
export const getMilestoneApprovalProgress = async (
  milestoneId: string,
  approvalThreshold: number,
  totalVerifiers?: number,
): Promise<{
  approved: number
  rejected: number
  pending: number
  required: number
  isComplete: boolean
  isRejected: boolean
  approvalPercentage: number
}> => {
  const approvals = await getMilestoneApprovals(milestoneId)
  const approved = approvals.approved.length
  const rejected = approvals.rejected.length
  const pending = approvals.pending.length
  const totalVoted = approved + rejected + pending

  // Veto math: can we still reach threshold?
  let isRejected: boolean
  if (totalVerifiers !== undefined && totalVerifiers > 0) {
    const remaining = totalVerifiers - totalVoted
    const maxPossibleApprovals = approved + Math.max(remaining, 0)
    isRejected = maxPossibleApprovals < approvalThreshold
  } else {
    // Legacy: any rejection vetoes
    isRejected = rejected > 0
  }

  const approvalPercentage = totalVoted === 0 ? 0 : Math.min((approved / totalVoted) * 100, 100)

  return {
    approved,
    rejected,
    pending,
    required: approvalThreshold,
    isComplete: approved >= approvalThreshold && !isRejected,
    isRejected,
    approvalPercentage,
  }
}

/**
 * Reset milestone approvals (for testing).
 */
export const resetMilestoneApprovals = async (): Promise<void> => {
  await db('milestone_approvals').del()
}

/**
 * Map database row to MilestoneApproval interface.
 */
function mapMilestoneApprovalRow(row: any): MilestoneApproval {
  return {
    id: row.id,
    milestoneId: row.milestone_id,
    verifierUserId: row.verifier_user_id,
    approvalStatus: row.approval_status,
    createdAt: row.created_at?.toISOString?.() ?? row.created_at,
    updatedAt: row.updated_at?.toISOString?.() ?? row.updated_at,
  }
}