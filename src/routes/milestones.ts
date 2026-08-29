import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'

import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  parseMilestoneInput,
  flattenZodErrors,
} from '../services/vaultValidation.js'

import { transitionVaultStatus } from '../services/vaultTransitions.js'
import { getVaultById } from '../services/vaultStore.js'
import { AppError } from '../middleware/errorHandler.js'
import { randomUUID } from 'node:crypto'
import db from '../db/index.js'
import { MilestoneRepositoryEnhanced } from '../repositories/milestoneRepositoryEnhanced.js'
import {
  recordMilestoneApproval,
  hasVerifierVoted,
  getMilestoneApprovalProgress,
  getMilestoneApprovals,
  DuplicateVerifierVoteError,
  getVerifierProfile,
} from '../services/verifiers.js'
import type { MilestoneStatus } from '../types/milestone.js'

const milestoneRepo = new MilestoneRepositoryEnhanced(db)

export const milestonesRouter = Router({ mergeParams: true })

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, async (req: Request, res: Response, next: NextFunction) => {

  const { vaultId } = req.params
  const vault = await getVaultById(vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  if (vault.status !== 'active') {
    return next(AppError.conflict('Cannot add milestones to a non-active vault'))
  }

  const parsed = parseMilestoneInput(req.body)
  if (!parsed.success) {
    return next(AppError.badRequest('Invalid milestone payload', flattenZodErrors(parsed.error)))
  }

  const { title, description, dueDate, amount } = parsed.data

  const { approvalThreshold = 1 } = req.body as { approvalThreshold?: number }
  if (!Number.isInteger(approvalThreshold) || approvalThreshold < 1) {
    return next(AppError.badRequest('approvalThreshold must be a positive integer'))
  }

  const milestoneId = `ms-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const now = new Date().toISOString()

  const dbMilestone = await milestoneRepo.create({
    id: milestoneId,
    vault_id: vaultId,
    title,
    description: description || null,
    type: 'verifier' as const,
    criteria: {
      verifierId: vault.verifier,
      approvalThreshold,
    } as any,
    weight: 1,
    status: 'pending' as MilestoneStatus,
    created_at: now,
  })

  res.status(201).json({
    id: dbMilestone.id,
    vaultId: dbMilestone.vault_id,
    title: dbMilestone.title,
    description: dbMilestone.description,
    dueDate,
    amount,
    approvalThreshold,
    status: dbMilestone.status,
    createdAt: dbMilestone.created_at,
  })
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', authenticate, async (req: Request, res: Response, next: NextFunction) => {

  const { vaultId } = req.params
  const vault = await getVaultById(vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestones = await milestoneRepo.listByVault(vaultId)
  res.json({
    milestones: milestones.map((m) => ({
      id: m.id,
      vaultId: m.vault_id,
      title: m.title,
      description: m.description,
      status: m.status,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
    }))
  })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {

  const { vaultId, id } = req.params
  const verifierUserId = req.user!.userId

  const result = await db.transaction(async (trx) => {
    const vault = await trx('vaults').where({ id: vaultId }).first()
    if (!vault) {
      return { success: false as const, error: 'Vault not found' }
    }

    const milestone = await milestoneRepo.getById(id, trx)
    if (!milestone || milestone.vault_id !== vaultId) {
      return { success: false as const, error: 'Milestone not found' }
    }

    if (milestone.status === 'approved') {
      await milestoneRepo.addMilestoneEvent({
        userId: verifierUserId,
        vaultId: vaultId,
        name: 'milestone.verified',
        status: 'success',
      }, trx)
      return { success: true as const, milestone, vaultCompleted: false }
    }

    const verified = await milestoneRepo.verifyMilestoneAtomic(id, verifierUserId, undefined, trx)
    if (!verified) {
      return { success: false as const, error: 'Milestone not found' }
    }

    const allVerified = await milestoneRepo.allVerified(vaultId, trx)
    let vaultCompleted = false

    if (allVerified && vault.status === 'active') {
      const trxResult = await transitionVaultStatus(trx, vaultId, 'completed')
      if (!trxResult.success) {
        return { success: false as const, error: trxResult.error }
      }
      vaultCompleted = true

      await milestoneRepo.addMilestoneEvent({
        userId: verifierUserId,
        vaultId: vaultId,
        name: 'vault.completed',
        status: 'success',
      }, trx)
    }

    return { success: true as const, milestone: verified, vaultCompleted }
  })

  if (!result.success) {
    return next(AppError.notFound((result.error || 'Operation failed') as string))
  }

  res.json({
    milestone: {
      id: result.milestone.id,
      vaultId: result.milestone.vault_id,
      description: result.milestone.description,
      verified: result.milestone.status === 'approved',
      verifiedAt: result.milestone.updated_at as string,
      verifiedBy: (result.milestone.criteria && typeof result.milestone.criteria === 'object' && 'verifiedBy' in result.milestone.criteria) ? (result.milestone.criteria as any).verifiedBy : null,
      evidenceHash: (result.milestone.criteria && typeof result.milestone.criteria === 'object' && 'evidenceHash' in result.milestone.criteria) ? (result.milestone.criteria as any).evidenceHash : null,
      createdAt: result.milestone.created_at,
    },
    vaultCompleted: result.vaultCompleted,
  })
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

  const result = await db.transaction(async (trx) => {
    const vault = await trx('vaults').where({ id: vaultId }).first()
    if (!vault) {
      return { success: false as const, error: 'Vault not found', code: 'NOT_FOUND' as const }
    }

    const milestone = await milestoneRepo.getById(id, trx)
    if (!milestone || milestone.vault_id !== vaultId) {
      return { success: false as const, error: 'Milestone not found', code: 'NOT_FOUND' as const }
    }

    if (milestone.status === 'approved') {
      return { success: false as const, error: 'Milestone already validated', code: 'CONFLICT' as const }
    }

    const criteria = typeof (milestone.criteria as any) === 'string' ? JSON.parse(milestone.criteria as any) : milestone.criteria
    if ((criteria as any).verifierId && (criteria as any).verifierId !== validatorUserId) {
      return { success: false as const, error: 'Unauthorized: only assigned verifier can validate', code: 'FORBIDDEN' as const }
    }

    const verified = await milestoneRepo.verifyMilestoneAtomic(id, validatorUserId, cleanEvidenceHash, trx)
    if (!verified) {
      return { success: false as const, error: 'Milestone not found', code: 'NOT_FOUND' as const }
    }

    const allVerified = await milestoneRepo.allVerified(vaultId, trx)
    let vaultCompleted = false

    if (allVerified && vault.status === 'active') {
      const trxResult = await transitionVaultStatus(trx, vaultId, 'completed')
      if (!trxResult.success) {
        return { success: false as const, error: trxResult.error, code: 'INTERNAL' as const }
      }
      vaultCompleted = true

      await milestoneRepo.addMilestoneEvent({
        userId: validatorUserId,
        vaultId: vaultId,
        name: 'vault.completed',
        status: 'success',
      }, trx)
    }

    return { success: true as const, milestone: verified, vaultCompleted }
  })

  if (!result.success) {
    switch (result.code) {
      case 'CONFLICT':
        return next(AppError.conflict(result.error))
      case 'FORBIDDEN':
        return next(AppError.forbidden(result.error))
      case 'NOT_FOUND':
        return next(AppError.notFound(result.error as string))
      default:
        return next(AppError.badRequest(result.error as string))
    }
  }

  res.json({
    milestone: {
      id: result.milestone.id,
      vaultId: result.milestone.vault_id,
      description: result.milestone.description,
      verified: result.milestone.status === 'approved',
      verifiedAt: result.milestone.updated_at,
      verifiedBy: (result.milestone.criteria && typeof result.milestone.criteria === 'object' && 'verifiedBy' in result.milestone.criteria) ? (result.milestone.criteria as any).verifiedBy : null,
      evidenceHash: (result.milestone.criteria && typeof result.milestone.criteria === 'object' && 'evidenceHash' in result.milestone.criteria) ? (result.milestone.criteria as any).evidenceHash : null,
      createdAt: result.milestone.created_at,
    },
    vaultCompleted: result.vaultCompleted,
  })
})

// POST /api/vaults/:vaultId/milestones/:id/approve
// Multi-verifier approval endpoint with duplicate-vote prevention
milestonesRouter.post('/:id/approve', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vaultId, id } = req.params
    const verifierUserId = req.user!.userId
    const { approvalStatus } = req.body as { approvalStatus?: string }

    if (!approvalStatus || !['approved', 'rejected'].includes(approvalStatus)) {
      return next(AppError.badRequest('approvalStatus must be "approved" or "rejected"'))
    }

    const vault = await getVaultById(vaultId)
    if (!vault) {
      return next(AppError.notFound('Vault not found'))
    }

    const milestone = await milestoneRepo.getById(id)
    if (!milestone || milestone.vault_id !== vaultId) {
      return next(AppError.notFound('Milestone not found'))
    }

    const verifier = await getVerifierProfile(verifierUserId)
    if (verifier && verifier.status !== 'approved') {
      return next(AppError.forbidden('Only approved verifiers may cast milestone approvals'))
    }

    const approvalThreshold = (milestone.criteria && typeof milestone.criteria === 'object' && 'approvalThreshold' in milestone.criteria)
      ? (milestone.criteria as any).approvalThreshold
      : 1
    const totalVerifiers = (milestone.criteria && typeof milestone.criteria === 'object' && 'totalVerifiers' in milestone.criteria)
      ? (milestone.criteria as any).totalVerifiers
      : undefined

    const priorProgress = await getMilestoneApprovalProgress(id, approvalThreshold, totalVerifiers)
    if (priorProgress.isComplete || priorProgress.isRejected) {
      return next(AppError.conflict('Milestone is already settled'))
    }

    const approval = await recordMilestoneApproval(id, verifierUserId, approvalStatus as any)

    const approvalProgress = await getMilestoneApprovalProgress(id, approvalThreshold, totalVerifiers)

    let milestoneCompleted = false
    let vaultCompleted = false
    let approvedMilestone = milestone

    if (approvalProgress.isComplete) {
      const trxResult = await db.transaction(async (trx) => {
        const updatedMilestone = await milestoneRepo.approveMilestoneAtomic(id, verifierUserId, trx)
        if (!updatedMilestone) {
          return { success: false as const, error: 'Milestone not found' }
        }
        approvedMilestone = updatedMilestone
        milestoneCompleted = true

        const vaultMilestones = await milestoneRepo.listByVault(vaultId, trx)
        const approvalCounts: Record<string, number> = {}
        const rejectionCounts: Record<string, number> = {}
        const totalVerifierCounts: Record<string, number> = {}

        await Promise.all(vaultMilestones.map(async (m) => {
          const votes = await getMilestoneApprovals(m.id, trx)
          approvalCounts[m.id] = votes.approved.length
          rejectionCounts[m.id] = votes.rejected.length
          const n = (m.criteria && typeof m.criteria === 'object' && 'totalVerifiers' in m.criteria)
            ? (m.criteria as any).totalVerifiers
            : undefined
          if (n !== undefined) totalVerifierCounts[m.id] = n
        }))

        if (await milestoneRepo.allMetThreshold(vaultId, approvalCounts, rejectionCounts, totalVerifierCounts, trx) && vault.status === 'active') {
          const vaultResult = await transitionVaultStatus(trx, vaultId, 'completed')
          if (!vaultResult.success) {
            return { success: false as const, error: vaultResult.error }
          }
          vaultCompleted = true

          await milestoneRepo.addMilestoneEvent({
            userId: verifierUserId,
            vaultId: vaultId,
            name: 'vault.completed',
            status: 'success',
          }, trx)
        }

        return { success: true as const }
      })

      if (!trxResult.success) {
        return next(AppError.badRequest(trxResult.error || 'Transition failed'))
      }
    }

    res.status(201).json({
      approval,
      approvalProgress,
      milestone: {
        id: approvedMilestone.id,
        vaultId: approvedMilestone.vault_id,
        description: approvedMilestone.description,
        approvalThreshold,
        verified: milestoneCompleted,
        verifiedAt: milestoneCompleted ? approvedMilestone.updated_at : null,
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
// Get detailed approval status for a milestone (requires authentication)
milestonesRouter.get('/:id/approval-status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vaultId, id } = req.params

    const vault = await getVaultById(vaultId)
    if (!vault) {
      return next(AppError.notFound('Vault not found'))
    }

    const milestone = await milestoneRepo.getById(id)
    if (!milestone || milestone.vault_id !== vaultId) {
      return next(AppError.notFound('Milestone not found'))
    }

    const approvalThreshold = (milestone.criteria && typeof milestone.criteria === 'object' && 'approvalThreshold' in milestone.criteria)
      ? (milestone.criteria as any).approvalThreshold
      : 1
    const approvalProgress = await getMilestoneApprovalProgress(id, approvalThreshold)

    res.json({
      milestone: {
        id: milestone.id,
        vaultId: milestone.vault_id,
        description: milestone.description,
        approvalThreshold,
      },
      approvalStatus: approvalProgress,
    })
  } catch (error) {
    next(error)
  }
})
