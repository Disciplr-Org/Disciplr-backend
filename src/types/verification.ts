
export type MilestoneVerificationStatus =
  | 'pending_verification'
  | 'info_requested'
  | 'approved'
  | 'rejected'

//  DB row shapes 

export interface MilestoneVerifier {
  id: string
  vault_id: string
  milestone_index: number
  verifier_address: string
  verifier_email: string | null
  assigned_by: string
  assigned_at: Date
  revoked_at: Date | null
}

export interface MilestoneVerificationEvent {
  id: string
  vault_id: string
  milestone_index: number
  verifier_address: string
  action: MilestoneVerificationStatus
  notes: string | null
  info_request_id: string | null
  previous_status: string | null
  created_at: Date
}

export interface MilestoneInfoRequest {
  id: string
  vault_id: string
  milestone_index: number
  requested_by: string
  question: string
  responding_party: string
  response_notes: string | null
  responded_at: Date | null
  is_resolved: boolean
  resolved_at: Date | null
  created_at: Date
}

// ── Service input types ───────────────────────────────────────────────────────

export interface VerifierContext {
  /** Address of the verifier taking the action */
  verifierAddress: string
  vaultId: string
  milestoneIndex: number
}

export interface ApproveMilestoneInput extends VerifierContext {
  notes?: string
}

export interface RejectMilestoneInput extends VerifierContext {
  /** Required: verifier must explain the rejection */
  notes: string
}

export interface RequestMoreInfoInput extends VerifierContext {
  /** The specific question / information needed */
  question: string
  /** Address of the party who should respond (usually vault creator) */
  respondingParty: string
}

// ── Service result ────────────────────────────────────────────────────────────

export interface VerificationResult {
  success: boolean
  eventId: string
  newStatus: MilestoneVerificationStatus
  infoRequestId?: string
}

// ── Notification hook payload (stubbed) ──────────────────────────────────────

export type NotificationEvent =
  | { type: 'milestone_approved';      vaultId: string; milestoneIndex: number; verifierAddress: string; notes?: string }
  | { type: 'milestone_rejected';      vaultId: string; milestoneIndex: number; verifierAddress: string; notes: string }
  | { type: 'milestone_info_requested';vaultId: string; milestoneIndex: number; verifierAddress: string; question: string; respondingParty: string; infoRequestId: string }