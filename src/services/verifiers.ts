import { db } from '../db/index.js'

export type VerifierStatus = 'pending' | 'approved' | 'suspended'

export interface VerifierProfile {
  userId: string
  displayName?: string | null
  metadata?: Record<string, unknown> | null
  status: VerifierStatus
  createdAt: string
  approvedAt?: string | null
  suspendedAt?: string | null
}

export interface VerificationRecord {
  id: string
  verifierUserId: string
  targetId: string
  result: 'approved' | 'rejected'
  disputed: boolean
  timestamp: string
}

export const createOrGetVerifierProfile = async (userId: string, opts?: { displayName?: string; metadata?: Record<string, unknown> }) => {
  const existing = await db('verifiers').where({ user_id: userId }).first()
  if (existing) return mapVerifierRow(existing)

  const [inserted] = await db('verifiers')
    .insert({
      user_id: userId,
      display_name: opts?.displayName ?? null,
      metadata: opts?.metadata ?? null,
    })
    .returning('*')

  return mapVerifierRow(inserted)
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

export const setVerifierStatus = async (userId: string, status: VerifierStatus): Promise<VerifierProfile | null> => {
  const updates: any = { status }
  if (status === 'approved') updates.approved_at = db.fn.now()
  if (status === 'suspended') updates.suspended_at = db.fn.now()

  const row = await db('verifiers').where({ user_id: userId }).first()
  if (!row) return null

  const [updated] = await db('verifiers').where({ user_id: userId }).update(updates).returning('*')
  return mapVerifierRow(updated)
}

export const recordVerification = async (verifierUserId: string, targetId: string, result: 'approved' | 'rejected', disputed = false): Promise<VerificationRecord> => {
  const [rec] = await db('verifications')
    .insert({ verifier_user_id: verifierUserId, target_id: targetId, result, disputed })
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

// Helpers for tests and development
export const resetVerifiers = async (): Promise<void> => {
  await db('verifications').del()
  await db('verifiers').del()
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
  }
}

function mapVerificationRow(row: any): VerificationRecord {
  return {
    id: row.id,
    verifierUserId: row.verifier_user_id,
    targetId: row.target_id,
    result: row.result,
    disputed: !!row.disputed,
    timestamp: row.timestamp?.toISOString?.() ?? row.timestamp,
  }
}
