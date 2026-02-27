import type { MilestoneVerifier, ApprovalPolicyResult, MilestoneDecisionSummary } from '../types/milestone.js'

export class ApprovalPolicyService {
  /**
   * Calculate the final approval status based on verifier decisions
   */
  static calculateApprovalResult(
    milestoneVerifiers: MilestoneVerifier[],
    approvalPolicy: 'all' | 'majority'
  ): ApprovalPolicyResult {
    const totalVerifiers = milestoneVerifiers.length
    const approvedCount = milestoneVerifiers.filter(mv => mv.decision === 'approved').length
    const rejectedCount = milestoneVerifiers.filter(mv => mv.decision === 'rejected').length
    const pendingCount = milestoneVerifiers.filter(mv => mv.decision === 'pending').length

    if (totalVerifiers === 0) {
      return {
        approved: false,
        rejected: false,
        pending: true,
        reason: 'No verifiers assigned'
      }
    }

    switch (approvalPolicy) {
      case 'all':
        return this.calculateAllPolicy(approvedCount, rejectedCount, pendingCount, totalVerifiers)
      
      case 'majority':
        return this.calculateMajorityPolicy(approvedCount, rejectedCount, pendingCount, totalVerifiers)
      
      default:
        return {
          approved: false,
          rejected: false,
          pending: true,
          reason: 'Unknown approval policy'
        }
    }
  }

  /**
   * All verifiers must approve for milestone to be approved
   * Any rejection immediately rejects the milestone
   */
  private static calculateAllPolicy(
    approvedCount: number,
    rejectedCount: number,
    pendingCount: number,
    totalVerifiers: number
  ): ApprovalPolicyResult {
    if (rejectedCount > 0) {
      return {
        approved: false,
        rejected: true,
        pending: false,
        reason: `${rejectedCount} verifier(s) rejected the milestone`
      }
    }

    if (approvedCount === totalVerifiers) {
      return {
        approved: true,
        rejected: false,
        pending: false,
        reason: `All ${totalVerifiers} verifier(s) approved the milestone`
      }
    }

    return {
      approved: false,
      rejected: false,
      pending: true,
      reason: `${approvedCount}/${totalVerifiers} verifiers have approved, ${pendingCount} pending`
    }
  }

  /**
   * Majority (>50%) of verifiers must approve for milestone to be approved
   * Majority (>50%) of verifiers must reject for milestone to be rejected
   * Otherwise, pending
   */
  private static calculateMajorityPolicy(
    approvedCount: number,
    rejectedCount: number,
    pendingCount: number,
    totalVerifiers: number
  ): ApprovalPolicyResult {
    const majorityThreshold = Math.floor(totalVerifiers / 2) + 1

    if (approvedCount >= majorityThreshold) {
      return {
        approved: true,
        rejected: false,
        pending: false,
        reason: `${approvedCount}/${totalVerifiers} verifiers approved (majority reached)`
      }
    }

    if (rejectedCount >= majorityThreshold) {
      return {
        approved: false,
        rejected: true,
        pending: false,
        reason: `${rejectedCount}/${totalVerifiers} verifiers rejected (majority reached)`
      }
    }

    return {
      approved: false,
      rejected: false,
      pending: true,
      reason: `${approvedCount} approved, ${rejectedCount} rejected, ${pendingCount} pending (majority not reached)`
    }
  }

  /**
   * Get a summary of milestone decisions
   */
  static getDecisionSummary(
    milestoneVerifiers: MilestoneVerifier[],
    approvalPolicy: 'all' | 'majority'
  ): MilestoneDecisionSummary {
    const totalVerifiers = milestoneVerifiers.length
    const approvedCount = milestoneVerifiers.filter(mv => mv.decision === 'approved').length
    const rejectedCount = milestoneVerifiers.filter(mv => mv.decision === 'rejected').length
    const pendingCount = milestoneVerifiers.filter(mv => mv.decision === 'pending').length

    const result = this.calculateApprovalResult(milestoneVerifiers, approvalPolicy)
    
    return {
      milestoneId: milestoneVerifiers[0]?.milestoneId || '',
      totalVerifiers,
      approvedCount,
      rejectedCount,
      pendingCount,
      finalStatus: result.approved ? 'approved' : result.rejected ? 'rejected' : 'pending',
      isComplete: !result.pending
    }
  }

  /**
   * Check if a milestone deadline has passed
   */
  static isExpired(deadline: string): boolean {
    return new Date(deadline) < new Date()
  }

  /**
   * Determine final status considering both approval and deadline
   */
  static getFinalStatus(
    milestoneVerifiers: MilestoneVerifier[],
    approvalPolicy: 'all' | 'majority',
    deadline: string
  ): 'pending' | 'approved' | 'rejected' | 'expired' {
    const approvalResult = this.calculateApprovalResult(milestoneVerifiers, approvalPolicy)
    
    // If expired and not already approved/rejected, mark as expired
    if (this.isExpired(deadline) && approvalResult.pending) {
      return 'expired'
    }

    if (approvalResult.approved) return 'approved'
    if (approvalResult.rejected) return 'rejected'
    
    return 'pending'
  }
}
