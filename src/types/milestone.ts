export interface Milestone {
  id: string
  vaultId: string
  title: string
  description?: string
  deadline: string
  status: 'pending' | 'approved' | 'rejected' | 'expired'
  approvalPolicy: 'all' | 'majority'
  createdAt: string
  updatedAt: string
}

export interface Verifier {
  id: string
  name: string
  email: string
  walletAddress?: string
  active: boolean
  createdAt: string
}

export interface MilestoneVerifier {
  id: string
  milestoneId: string
  verifierId: string
  decision: 'pending' | 'approved' | 'rejected'
  reason?: string
  decidedAt?: string
  createdAt: string
  updatedAt: string
}

export interface CreateMilestoneRequest {
  vaultId: string
  title: string
  description?: string
  deadline: string
  approvalPolicy?: 'all' | 'majority'
  verifierIds: string[]
}

export interface VerifierDecisionRequest {
  decision: 'approved' | 'rejected'
  reason?: string
}

export interface MilestoneDecisionSummary {
  milestoneId: string
  totalVerifiers: number
  approvedCount: number
  rejectedCount: number
  pendingCount: number
  finalStatus: 'pending' | 'approved' | 'rejected' | 'expired'
  isComplete: boolean
}

export interface ApprovalPolicyResult {
  approved: boolean
  rejected: boolean
  pending: boolean
  reason: string
}
