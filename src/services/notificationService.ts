/**
 * Stub notification service for milestone verification events.
 *
 * Each method is intentionally a no-op (returns immediately) so that the
 * verification service can call them unconditionally. When the real
 * implementation is built (email provider, push, webhook, etc.) only this
 * file changes — no edits needed in verificationService.ts.
 *
 * TODO (separate issue): replace stubs with real transport (e.g. Resend,
 * SendGrid, or an internal event bus).
 */

import type { NotificationEvent } from '../types/verification.js'

class NotificationService {
  /**
   * Dispatch a notification event.
   * Currently a stub — logs to console and returns immediately.
   */
  async dispatch(event: NotificationEvent): Promise<void> {
    // STUB: replace with real transport in the notifications issue
    console.info('[NotificationService] dispatch (stub):', JSON.stringify(event))
  }

  async notifyApproval(
    vaultId: string,
    milestoneIndex: number,
    verifierAddress: string,
    notes?: string,
  ): Promise<void> {
    await this.dispatch({ type: 'milestone_approved', vaultId, milestoneIndex, verifierAddress, notes })
  }

  async notifyRejection(
    vaultId: string,
    milestoneIndex: number,
    verifierAddress: string,
    notes: string,
  ): Promise<void> {
    await this.dispatch({ type: 'milestone_rejected', vaultId, milestoneIndex, verifierAddress, notes })
  }

  async notifyInfoRequested(
    vaultId: string,
    milestoneIndex: number,
    verifierAddress: string,
    question: string,
    respondingParty: string,
    infoRequestId: string,
  ): Promise<void> {
    await this.dispatch({
      type: 'milestone_info_requested',
      vaultId,
      milestoneIndex,
      verifierAddress,
      question,
      respondingParty,
      infoRequestId,
    })
  }
}

export const notificationService = new NotificationService()