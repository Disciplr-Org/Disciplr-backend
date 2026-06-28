import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  createMilestone,
  getMilestonesByVaultId,
  getMilestoneById,
  verifyMilestone,
  validateMilestone,
  allMilestonesVerified,
  allMilestonesMetThreshold,
} from '../services/milestones.js'
import {
  recordMilestoneApproval,
  hasVerifierVoted,
  getMilestoneApprovalProgress,
  getApprovedVerifiersCount,
  getMilestoneApprovals,
  hasMilestoneMetThreshold,
  DuplicateVerifierVoteError,
  getVerifierProfile,
} from '../services/verifiers.js'

import { completeVault } from '../services/vaultTransitions.js'
import { vaults } from './vaults.js'
import { getVaultById } from '../services/vaultStore.js'
import { AppError } from '../middleware/errorHandler.js'

export const milestonesRouter = Router({ mergeParams: true })

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, (req: Request, res: Response, next: NextFunction) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  if (vault.status !== 'active') {
    return next(AppError.conflict('Cannot add milestones to a non-active vault'))
  }

  const { description } = req.body as { description?: string }
  if (!description?.trim()) {
    return next(AppError.badRequest('description is required'))
  }

  const milestone = createMilestone(vaultId, description.trim(), vault.verifier)
  res.status(201).json(milestone)
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', (req: Request, res: Response, next: NextFunction) => {
  const { vaultId } = req.params
  const vault = vaults.find((v) => v.id === vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestones = getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, requireVerifier, (req: Request, res: Response, next: NextFunction) => {
  const { vaultId, id } = req.params

  const vault = vaults.find((v) => v.id === vaultId)
  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestone = getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    return next(AppError.notFound('Milestone not found'))
  }

  const verified = verifyMilestone(id)
  if (!verified) {
    return next(AppError.notFound('Milestone not found'))
  }

  let vaultCompleted = false
  if (allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: verified, vaultCompleted })
})

const EVIDENCE_HASH_RE = /^[0-9a-f]{32,128}$/i

// POST /api/vaults/:vaultId/milestones/:id/validate
milestonesRouter.post('/:id/validate', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  const { vaultId, id } = req.params
  const validatorUserId = req.user!.userId
  const { evidenceHash } = req.body as { evidenceHash?: string }

  if (!evidenceHash || !evidenceHash.trim()) {
    return next(AppError.badRequest('evidenceHash is required'))
  }

  const cleanEvidenceHash = evidenceHash.trim().toLowerCase()
  if (!EVIDENCE_HASH_RE.test(cleanEvidenceHash)) {
    return next(AppError.validation('evidenceHash must be a valid hex string (32–128 characters)'))
  }

  // Prefer DB-backed vault (has lateCheckInWindowSecs + PersistedMilestone.dueDate)
  const persistedVault = await getVaultById(vaultId).catch(() => null)
  const vault = persistedVault ?? vaults.find((v) => v.id === vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestone = getMilestoneById(id)
  if (!milestone || milestone.vaultId !== vaultId) {
    return next(AppError.notFound('Milestone not found'))
  }

  const result = validateMilestone(id, validatorUserId, cleanEvidenceHash)
  if (!result.success) {
    if (result.error === 'Milestone already validated') {
      return next(AppError.conflict('Milestone already validated'))
    }
    if (result.error === 'Unauthorized: only assigned verifier can validate') {
      return next(AppError.forbidden('Unauthorized: only assigned verifier can validate'))
    }
    return next(AppError.badRequest(result.error!))
  }

  let vaultCompleted = false
  if (allMilestonesVerified(vaultId) && vault.status === 'active') {
    const result = completeVault(vaultId)
    vaultCompleted = result.success
  }

  res.json({ milestone: result.milestone, vaultCompleted })
})

// POST /api/vaults/:vaultId/milestones/:id/approve
// Multi-verifier approval endpoint with duplicate-vote prevention
milestonesRouter.post('/:id/approve', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vaultId, id } = req.params
    const verifierUserId = req.user!.userId
    const { approvalStatus } = req.body as { approvalStatus?: string }

    // Validate input
    if (!approvalStatus || !['approved', 'rejected'].includes(approvalStatus)) {
      return next(AppError.badRequest('approvalStatus must be "approved" or "rejected"'))
    }

    // Check vault exists
    const vault = vaults.find((v) => v.id === vaultId)
    if (!vault) {
      return next(AppError.notFound('Vault not found'))
    }

    // Check milestone exists and belongs to vault
    const milestone = getMilestoneById(id)
    if (!milestone || milestone.vaultId !== vaultId) {
      return next(AppError.notFound('Milestone not found'))
    }

    // Reject approvals from suspended/deactivated verifiers (historical votes remain intact)
    const verifier = await getVerifierProfile(verifierUserId)
    if (verifier && (verifier.status === 'suspended' || verifier.status === 'deactivated')) {
      return next(AppError.forbidden('Suspended/deactivated verifier cannot cast milestone approvals'))
    }

    // Check if verifier has already voted (duplicate vote prevention)
    const hasVoted = await hasVerifierVoted(id, verifierUserId)

    if (hasVoted) {
      return next(AppError.conflict('Verifier has already voted on this milestone'))
    }

    // Reject late votes on already-settled milestones
    const milestone_record = getMilestoneById(id)
    const approvalThreshold = (milestone_record as any)?.approvalThreshold || 1
    const totalVerifiers = (milestone_record as any)?.totalVerifiers as number | undefined

    const priorProgress = await getMilestoneApprovalProgress(id, approvalThreshold, totalVerifiers)
    if (priorProgress.isComplete || priorProgress.isRejected) {
      return next(AppError.conflict('Milestone is already settled'))
    }

    // Record the approval
    const approval = await recordMilestoneApproval(id, verifierUserId, approvalStatus as any)

    // Get updated approval progress
    const approvalProgress = await getMilestoneApprovalProgress(id, approvalThreshold, totalVerifiers)

    // Settle milestone state
    let milestoneCompleted = false
    let vaultCompleted = false

    if (approvalProgress.isComplete) {
      milestoneCompleted = true
      milestone.verified = true
      milestone.verifiedAt = new Date().toISOString()
      milestone.verifiedBy = verifierUserId

      // Build approval/rejection counts for veto-aware vault check
      const vaultMilestones = getMilestonesByVaultId(vaultId)
      const approvalCounts: Record<string, number> = {}
      const rejectionCounts: Record<string, number> = {}
      const totalVerifierCounts: Record<string, number> = {}

      await Promise.all(vaultMilestones.map(async (m) => {
        const votes = await getMilestoneApprovals(m.id)
        approvalCounts[m.id] = votes.approved.length
        rejectionCounts[m.id] = votes.rejected.length
        const n = (m as any).totalVerifiers as number | undefined
        if (n !== undefined) totalVerifierCounts[m.id] = n
      }))

      if (allMilestonesMetThreshold(vaultId, approvalCounts, rejectionCounts, totalVerifierCounts) && vault.status === 'active') {
        const result = completeVault(vaultId)
        vaultCompleted = result.success
      }
    }

    res.status(201).json({
      approval,
      approvalProgress,
      milestone: {
        ...milestone,
        approvalThreshold,
      },
      milestoneCompleted,
      vaultCompleted,
    })
  } catch (error) {
    if (error instanceof DuplicateVerifierVoteError) {
      return next(AppError.conflict(error.message))
    }
    next(error)
  }
})

// GET /api/vaults/:vaultId/milestones/:id/approval-status
// Get detailed approval status for a milestone
milestonesRouter.get('/:id/approval-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vaultId, id } = req.params

    // Check vault exists
    const vault = vaults.find((v) => v.id === vaultId)
    if (!vault) {
      return next(AppError.notFound('Vault not found'))
    }

    // Check milestone exists
    const milestone = getMilestoneById(id)
    if (!milestone || milestone.vaultId !== vaultId) {
      return next(AppError.notFound('Milestone not found'))
    }

    const approvalThreshold = (milestone as any)?.approvalThreshold || 1
    const approvalProgress = await getMilestoneApprovalProgress(id, approvalThreshold)

    res.json({
      milestone: {
        id: milestone.id,
        vaultId: milestone.vaultId,
        description: milestone.description,
        approvalThreshold,
      },
      approvalStatus: approvalProgress,
    })
  } catch (error) {
    next(error)
  }
})
