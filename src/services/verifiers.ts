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
  deactivated: ['deactivated', 'pending', 'approved'],
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
    }, trx)

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
    }, trx)

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
    }, trx)

    return { deleted: true, before, auditLog }
  })
}

export const createOrTransitionVerifier = async (
  userId: string,
  status: VerifierStatus,
  context: VerifierMutationContext,
): Promise<VerifierMutationResult> => {
  return db.transaction(async (trx) => {
    let current = await trx('verifiers').where({ user_id: userId }).first()

    if (!current) {
      const insertedRows = await trx('verifiers')
        .insert({
          user_id: userId,
          display_name: null,
          metadata: null,
          ...mapStatusToUpdates(status),
        })
        .onConflict('user_id')
        .ignore()
        .returning('*')

      const inserted = insertedRows[0]
      if (inserted) {
        const after = mapVerifierRow(inserted)
        const changedFields = ['user_id', 'status']
        const auditLog = await createVerifierAuditLog({
          action: 'verifier.created',
          context,
          targetId: after.userId,
          before: null,
          after,
          changedFields,
        }, trx)

        return { before: null, after, changedFields, auditLog }
      }

      current = await trx('verifiers').where({ user_id: userId }).first()
      if (!current) {
        throw new Error('Verifier profile was not available after concurrent create')
      }
    }

    const before = mapVerifierRow(current)
    if (!canTransition(before.status, status)) {
      throw new InvalidVerifierStatusTransitionError(before.status, status)
    }

    if (before.status === status) {
      return { before, after: before, changedFields: [], auditLog: null }
    }

    const [updated] = await trx('verifiers')
      .where({ user_id: userId })
      .update(mapStatusToUpdates(status))
      .returning('*')

    const after = mapVerifierRow(updated)
    const action = statusAction(before.status, after.status)

    if (!action) {
      throw new Error(`Missing verifier audit action for ${before.status} -> ${after.status}`)
    }

    const auditLog = await createVerifierAuditLog({
      action,
      context,
      targetId: userId,
      before,
      after,
      changedFields: ['status'],
    }, trx)

    return { before, after, changedFields: ['status'], auditLog }
  })
}

export const getVerifierProfile = async (userId: string): Promise<VerifierProfile | undefined> => {
  const row = await db('verifiers').where({ user_id: userId }).first()
  if (!row) return undefined
  return mapVerifierRow(row)
}

export interface ListVerifierProfilesOptions {
  limit?: number
  offset?: number
}

export const listVerifierProfiles = async (opts: ListVerifierProfilesOptions = {}): Promise<VerifierProfile[]> => {
  const parsedLimit = Number(opts.limit)
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), 500)  // Cap at 500 to prevent resource exhaustion
    : 100
  const parsedOffset = Number(opts.offset)
  const offset = Number.isFinite(parsedOffset) && parsedOffset >= 0
    ? Math.floor(parsedOffset)
    : 0
  const rows = await db('verifiers').select('*').orderBy('created_at', 'desc').limit(limit).offset(offset)
  return rows.map(mapVerifierRow)
}

/**
 * @deprecated Use `transitionVerifier` directly.
 *
 * This wrapper exists only for backward-compatibility. It delegates to
 * `transitionVerifier` so that every status change goes through the full
 * validation pipeline: `canTransition` check, `db.transaction`, and
 * `createVerifierAuditLog`. Callers should migrate to `transitionVerifier`
 * and pass an explicit `VerifierMutationContext`.
 *
 * Accepts an optional `VerifierMutationContext` so callers that do have
 * actor/reason information can still get an accurate audit trail. When
 * omitted (the legacy call shape), the affected user is recorded as the
 * actor so the bypass-free path remains visible in the audit log.
 */
export const setVerifierStatus = async (
  userId: string,
  status: VerifierStatus,
  context?: VerifierMutationContext,
): Promise<VerifierProfile | null> => {
  const result = await transitionVerifier(userId, status, context ?? { actorUserId: userId })
  return result?.after ?? null
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
    if (existing.result !== result) {
      // Different decision — hard conflict.
      throw new VerificationConflictError()
    }

    // Same result but caller is submitting different evidence or changing the
    // disputed flag.  Surface the mismatch rather than silently discarding
    // the new information.
    const existingEvidenceHash: string | null = existing.evidence_hash ?? null
    const incomingEvidenceHash: string | null = evidenceHash ?? null
    const existingDisputed = !!existing.disputed

    if (existingEvidenceHash !== incomingEvidenceHash || existingDisputed !== disputed) {
      throw new VerificationConflictError()
    }

    return mapVerificationRow(existing)
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

export const listVerifications = async (targetIds?: string[]): Promise<VerificationRecord[]> => {
  const query = db('verifications').select('*').orderBy('timestamp', 'desc')
  if (targetIds && targetIds.length > 0) {
    query.whereIn('target_id', targetIds)
  }
  const rows = await query
  return rows.map(mapVerificationRow)
}

export const getVerifierStats = async (userId: string) => {
  const raw = await db.raw<{ rows: Array<{ total: string; approvals: string; rejections: string; disputes: string }> }>(
    `SELECT
       COUNT(*)                                          AS total,
       COUNT(*) FILTER (WHERE result    = 'approved')   AS approvals,
       COUNT(*) FILTER (WHERE result    = 'rejected')   AS rejections,
       COUNT(*) FILTER (WHERE disputed  = TRUE)         AS disputes
     FROM verifications
     WHERE verifier_user_id = ?`,
    [userId],
  )

  const row = raw.rows[0]
  const total = Number(row?.total ?? 0)
  const approvals = Number(row?.approvals ?? 0)
  const rejections = Number(row?.rejections ?? 0)
  const disputes = Number(row?.disputes ?? 0)

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
}, trx?: Knex.Transaction): Promise<AuditLog> {
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
  }, trx)
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
 * Validate that a value is a non-empty string.
 * Used as a hostile-input guard for identifiers.
 */
const assertNonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`)
  }
  return value
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
  // Hostile-input boundary: reject empty/missing identifiers early.
  assertNonEmptyString(milestoneId, 'milestoneId')
  assertNonEmptyString(verifierUserId, 'verifierUserId')

  if (approvalStatus !== 'approved' && approvalStatus !== 'rejected') {
    throw new Error('approvalStatus must be "approved" or "rejected"')
  }

  return db.transaction(async (trx) => {
    const existing = await trx('milestone_approvals')
      .where({
        milestone_id: milestoneId,
        verifier_user_id: verifierUserId,
      })
      .first()

    if (existing) {
      throw new DuplicateVerifierVoteError(milestoneId, verifierUserId)
    }

    try {
      const [record] = await trx('milestone_approvals')
        .insert({
          milestone_id: milestoneId,
          verifier_user_id: verifierUserId,
          approval_status: approvalStatus,
        })
        .returning('*')

      return mapMilestoneApprovalRow(record)
    } catch (err) {
      const maybeErr = err as { code?: string; message?: string }
      if (
        maybeErr.code === '23505'
        || maybeErr.message?.toLowerCase().includes('unique') === true
      ) {
        throw new DuplicateVerifierVoteError(milestoneId, verifierUserId)
      }
      throw err
    }
  })
}

/**
 * Get all approvals for a milestone, grouped by approval status.
 */
export const getMilestoneApprovals = async (
  milestoneId: string,
  trx?: Knex.Transaction,
): Promise<{
  approved: MilestoneApproval[]
  rejected: MilestoneApproval[]
  pending: MilestoneApproval[]
}> => {
  interface MilestoneApprovalRow {
    id: string
    milestone_id: string
    verifier_user_id: string
    approval_status: unknown
    created_at: string
    updated_at: string
  }

  const client = trx ?? db
  const rows = await client<MilestoneApprovalRow>('milestone_approvals')
    .where({ milestone_id: milestoneId })
    .orderBy('created_at', 'asc')

  const VALID_STATUSES = new Set<MilestoneApprovalStatus>(['approved', 'rejected', 'pending'])

  const grouped: Record<MilestoneApprovalStatus, MilestoneApproval[]> = {
    approved: [],
    rejected: [],
    pending: [],
  }

  rows.forEach((row) => {
    const status = row.approval_status
    if (typeof status !== 'string' || !VALID_STATUSES.has(status as MilestoneApprovalStatus)) {
      // Unrecognised status from DB — route to pending rather than throw
      grouped.pending.push(mapMilestoneApprovalRow(row))
      return
    }
    grouped[status as MilestoneApprovalStatus].push(mapMilestoneApprovalRow(row))
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
  trx?: Knex.Transaction,
): Promise<{
  approved: number
  rejected: number
  pending: number
  required: number
  isComplete: boolean
  isRejected: boolean
  approvalPercentage: number
}> => {
  // A milestone always requires at least one approval, so clamp a non-positive
  // or non-numeric threshold to 1. NaN must be treated as unknown (=1) rather
  // than leaking into comparisons.
  const safeThreshold =
    typeof approvalThreshold === 'number' && Number.isFinite(approvalThreshold)
      ? Math.max(1, Math.floor(approvalThreshold))
      : 1

  const approvals = await getMilestoneApprovals(milestoneId, trx)
  const approved = approvals.approved.length
  const rejected = approvals.rejected.length
  const pending = approvals.pending.length
  const totalVoted = approved + rejected + pending

  // Hostile-input boundary: clamp totals to sane ranges so malformed input
  // cannot produce a degenerate veto/complete result.
  const safeTotal =
    totalVerifiers !== undefined && totalVerifiers > 0
      ? Math.max(1, Math.floor(Number(totalVerifiers)))
      : undefined

  // Veto math: can we still reach threshold?
  let isRejected: boolean
  if (safeTotal !== undefined) {
    const remaining = safeTotal - totalVoted
    const maxPossibleApprovals = approved + Math.max(remaining, 0)
    isRejected = maxPossibleApprovals < safeThreshold
  } else {
    // Legacy: any rejection vetoes
    isRejected = rejected > 0
  }

  const approvalPercentage = totalVoted === 0 ? 0 : Math.min((approved / totalVoted) * 100, 100)

  return {
    approved,
    rejected,
    pending,
    required: safeThreshold,
    isComplete: approved >= safeThreshold && !isRejected,
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
