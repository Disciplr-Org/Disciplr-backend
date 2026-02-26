/**
 * services/verificationService.ts
 *
 * Manual milestone verification service.
 * Implements approveMilestone, rejectMilestone, requestMoreInfo.
 *
 * Responsibilities:
 *  1. Role check  – caller must be an active assigned verifier for the milestone.
 *  2. State guard – milestone must be in a valid status for the requested transition.
 *  3. DB writes   – update milestone status + write immutable event + optional info request.
 *  4. Notify      – fire-and-forget notification hooks (stubbed).
 *
 * All three public methods run inside a single Knex transaction so the DB
 * is never left in a partial state.
 */

import { db } from './knex.js'
import { notificationService } from './notificationService.js'
import type {
  ApproveMilestoneInput,
  RejectMilestoneInput,
  RequestMoreInfoInput,
  MilestoneVerificationStatus,
  VerificationResult,
  MilestoneVerifier,
} from '../types/verification.js'

// ── Errors ────────────────────────────────────────────────────────────────────

export class VerificationError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'NOT_AUTHORIZED'
      | 'INVALID_STATUS_TRANSITION'
      | 'MILESTONE_NOT_FOUND'
      | 'OPEN_INFO_REQUEST',
  ) {
    super(message)
    this.name = 'VerificationError'
  }
}

// ── Status transition rules ───────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<string, MilestoneVerificationStatus[]> = {
  pending_verification: ['approved', 'rejected', 'info_requested'],
  info_requested: ['approved', 'rejected', 'info_requested'],
  // Terminal states – no further transitions
  approved: [],
  rejected: [],
}

function assertTransition(current: string, next: MilestoneVerificationStatus): void {
  const allowed = ALLOWED_TRANSITIONS[current] ?? []
  if (!allowed.includes(next)) {
    throw new VerificationError(
      `Cannot transition milestone from '${current}' to '${next}'.`,
      'INVALID_STATUS_TRANSITION',
    )
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Asserts the caller is an active (non-revoked) assigned verifier.
 * Must be called inside an existing transaction.
 */
async function assertVerifierRole(
  trx: typeof db,
  vaultId: string,
  milestoneIndex: number,
  verifierAddress: string,
): Promise<MilestoneVerifier> {
  const assignment = await trx<MilestoneVerifier>('milestone_verifiers')
    .where({
      vault_id: vaultId,
      milestone_index: milestoneIndex,
      verifier_address: verifierAddress,
    })
    .whereNull('revoked_at')
    .first()

  if (!assignment) {
    throw new VerificationError(
      `Address ${verifierAddress} is not an assigned verifier for vault ${vaultId} milestone ${milestoneIndex}.`,
      'NOT_AUTHORIZED',
    )
  }

  return assignment
}

/**
 * Fetches the current verification status of a milestone from the OLTP
 * analytics.milestone_performance table (written by the ETL / vault service).
 *
 * Falls back gracefully if the row doesn't exist yet (new vault).
 */
async function getMilestoneStatus(
  trx: typeof db,
  vaultId: string,
  milestoneIndex: number,
): Promise<string> {
  const row = await trx('analytics.milestone_performance')
    .where({ vault_id: vaultId, milestone_index: milestoneIndex })
    .select('status')
    .first()

  if (!row) {
    throw new VerificationError(
      `Milestone ${milestoneIndex} not found for vault ${vaultId}.`,
      'MILESTONE_NOT_FOUND',
    )
  }

  return row.status as string
}

/**
 * Writes a verification event record.
 * Must be called inside an existing transaction.
 */
async function writeEvent(
  trx: typeof db,
  params: {
    vaultId: string
    milestoneIndex: number
    verifierAddress: string
    action: MilestoneVerificationStatus
    notes?: string
    infoRequestId?: string
    previousStatus: string
  },
): Promise<string> {
  const [event] = await trx('milestone_verification_events')
    .insert({
      vault_id: params.vaultId,
      milestone_index: params.milestoneIndex,
      verifier_address: params.verifierAddress,
      action: params.action,
      notes: params.notes ?? null,
      info_request_id: params.infoRequestId ?? null,
      previous_status: params.previousStatus,
    })
    .returning('id')

  return event.id as string
}

/**
 * Updates the milestone status in analytics.milestone_performance.
 * The analytics schema is the shared status store read by both the
 * verification service and the analytics engine.
 */
async function updateMilestoneStatus(
  trx: typeof db,
  vaultId: string,
  milestoneIndex: number,
  status: MilestoneVerificationStatus,
): Promise<void> {
  await trx('analytics.milestone_performance')
    .where({ vault_id: vaultId, milestone_index: milestoneIndex })
    .update({ status, analytics_updated_at: trx.fn.now() })
}

// ── Service class ─────────────────────────────────────────────────────────────

class VerificationService {
  /**
   * Approve a milestone.
   *
   * Allowed from: pending_verification, info_requested
   * Transitions to: approved
   */
  async approveMilestone(input: ApproveMilestoneInput): Promise<VerificationResult> {
    const { verifierAddress, vaultId, milestoneIndex, notes } = input

    const result = await db.transaction(async (trx) => {
      await assertVerifierRole(trx, vaultId, milestoneIndex, verifierAddress)
      const previousStatus = await getMilestoneStatus(trx, vaultId, milestoneIndex)
      assertTransition(previousStatus, 'approved')

      await updateMilestoneStatus(trx, vaultId, milestoneIndex, 'approved')

      const eventId = await writeEvent(trx, {
        vaultId,
        milestoneIndex,
        verifierAddress,
        action: 'approved',
        notes,
        previousStatus,
      })

      // Resolve any open info requests for this milestone
      await trx('milestone_info_requests')
        .where({ vault_id: vaultId, milestone_index: milestoneIndex, is_resolved: false })
        .update({ is_resolved: true, resolved_at: trx.fn.now() })

      return { eventId, previousStatus }
    })

    // Fire-and-forget notification (stub)
    notificationService
      .notifyApproval(vaultId, milestoneIndex, verifierAddress, notes)
      .catch((err) => console.error('[verificationService] notify approval error', err))

    return { success: true, eventId: result.eventId, newStatus: 'approved' }
  }

  /**
   * Reject a milestone.
   *
   * Allowed from: pending_verification, info_requested
   * Transitions to: rejected
   * Notes are required so the submitter understands why.
   */
  async rejectMilestone(input: RejectMilestoneInput): Promise<VerificationResult> {
    const { verifierAddress, vaultId, milestoneIndex, notes } = input

    const result = await db.transaction(async (trx) => {
      await assertVerifierRole(trx, vaultId, milestoneIndex, verifierAddress)
      const previousStatus = await getMilestoneStatus(trx, vaultId, milestoneIndex)
      assertTransition(previousStatus, 'rejected')

      await updateMilestoneStatus(trx, vaultId, milestoneIndex, 'rejected')

      const eventId = await writeEvent(trx, {
        vaultId,
        milestoneIndex,
        verifierAddress,
        action: 'rejected',
        notes,
        previousStatus,
      })

      // Resolve any open info requests
      await trx('milestone_info_requests')
        .where({ vault_id: vaultId, milestone_index: milestoneIndex, is_resolved: false })
        .update({ is_resolved: true, resolved_at: trx.fn.now() })

      return { eventId }
    })

    notificationService
      .notifyRejection(vaultId, milestoneIndex, verifierAddress, notes)
      .catch((err) => console.error('[verificationService] notify rejection error', err))

    return { success: true, eventId: result.eventId, newStatus: 'rejected' }
  }

  /**
   * Request additional information before making a decision.
   *
   * Allowed from: pending_verification, info_requested
   * Transitions to: info_requested
   *
   * Multiple info requests are allowed (e.g. follow-up questions), but a new
   * request cannot be opened if there is already an unresolved one from the
   * same verifier for the same milestone.
   */
  async requestMoreInfo(input: RequestMoreInfoInput): Promise<VerificationResult> {
    const { verifierAddress, vaultId, milestoneIndex, question, respondingParty } = input

    const result = await db.transaction(async (trx) => {
      await assertVerifierRole(trx, vaultId, milestoneIndex, verifierAddress)
      const previousStatus = await getMilestoneStatus(trx, vaultId, milestoneIndex)
      assertTransition(previousStatus, 'info_requested')

      // Guard: block duplicate open requests from the same verifier
      const openRequest = await trx('milestone_info_requests')
        .where({
          vault_id: vaultId,
          milestone_index: milestoneIndex,
          requested_by: verifierAddress,
          is_resolved: false,
        })
        .first()

      if (openRequest) {
        throw new VerificationError(
          `An open info request already exists (id: ${openRequest.id}). Resolve it before opening another.`,
          'OPEN_INFO_REQUEST',
        )
      }

      // Create the info request record
      const [infoRequest] = await trx('milestone_info_requests')
        .insert({
          vault_id: vaultId,
          milestone_index: milestoneIndex,
          requested_by: verifierAddress,
          question,
          responding_party: respondingParty,
        })
        .returning('id')

      const infoRequestId = infoRequest.id as string

      await updateMilestoneStatus(trx, vaultId, milestoneIndex, 'info_requested')

      const eventId = await writeEvent(trx, {
        vaultId,
        milestoneIndex,
        verifierAddress,
        action: 'info_requested',
        notes: question,
        infoRequestId,
        previousStatus,
      })

      return { eventId, infoRequestId }
    })

    notificationService
      .notifyInfoRequested(
        vaultId,
        milestoneIndex,
        verifierAddress,
        question,
        respondingParty,
        result.infoRequestId,
      )
      .catch((err) => console.error('[verificationService] notify info request error', err))

    return {
      success: true,
      eventId: result.eventId,
      newStatus: 'info_requested',
      infoRequestId: result.infoRequestId,
    }
  }

  /**
   * Fetch the full verification audit trail for a milestone.
   */
  async getVerificationHistory(
    vaultId: string,
    milestoneIndex: number,
  ) {
    return db('milestone_verification_events')
      .where({ vault_id: vaultId, milestone_index: milestoneIndex })
      .orderBy('created_at', 'asc')
  }

  /**
   * Fetch all active verifier assignments for a milestone.
   */
  async getAssignedVerifiers(vaultId: string, milestoneIndex: number) {
    return db('milestone_verifiers')
      .where({ vault_id: vaultId, milestone_index: milestoneIndex })
      .whereNull('revoked_at')
  }
}

export const verificationService = new VerificationService()