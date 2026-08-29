import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'

import { vaults } from './vaults.js'

import { requireUser, requireVerifier } from '../middleware/rbac.js'
import {
  createMilestoneWithThreshold,
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
  getMilestoneApprovals,
  DuplicateVerifierVoteError,
  getVerifierProfile,
} from '../services/verifiers.js'
import {
  parseMilestoneInput,
  flattenZodErrors,
} from '../services/vaultValidation.js'

import { completeVault, transitionVaultStatus } from '../services/vaultTransitions.js'
import { getVaultById } from '../services/vaultStore.js'
import { AppError } from '../middleware/errorHandler.js'
import db from '../db/index.js'

import {
  validateIdempotencyKey,
  scopeIdempotencyKey,
  hashRequestPayload,
  getIdempotentResponse,
  saveIdempotentResponse,
  failPendingIdempotentResponse,
  IdempotencyConflictError,
  IdempotencyOwnerMismatchError,
  type OwnerContext,
} from '../services/idempotency.js'

// ┌─── Boundary validation helpers ───────────────────────────────────────

const VAULT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isValidVaultId = (value: string): boolean => VAULT_ID_RE.test(value)

const requireValidVaultId = (req: Request, res: Response, next: NextFunction): void => {
  if (!isValidVaultId(req.params.vaultId)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Vault id must be a valid UUID' } })
    return
  }
  next()
}

const MILESTONE_ID_RE = /^ms-[0-9]+-[a-z0-9]+$/i
const isValidMilestoneId = (value: string): boolean => MILESTONE_ID_RE.test(value)

const requireValidMilestoneId = (req: Request, res: Response, next: NextFunction): void => {
  if (!isValidMilestoneId(req.params.id)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Milestone id is malformed' } })
    return
  }
  next()
}

const resolveActorUserId = (req: Request): string | null =>
  req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null

function assertValidMilestoneResponse(value: unknown): void {
  if (!value || typeof value !== 'object') throw new Error('malformed response')
}

export const milestonesRouter = Router({ mergeParams: true })

async function handleIdempotency<T>(
  req: Request,
  res: Response,
  next: NextFunction,
  actorUserId: string,
  owner: OwnerContext,
  handler: () => Promise<{ status: number, body: any }>
) {
  const rawIdempotencyKey = req.header('idempotency-key') ?? null
  let scopedIdempotencyKey: string | null = null

  if (rawIdempotencyKey) {
    const validation = validateIdempotencyKey(rawIdempotencyKey)
    if (!validation.valid) {
      res.status(400).json({ error: { code: validation.code, message: validation.error } })
      return
    }
    scopedIdempotencyKey = scopeIdempotencyKey(actorUserId, rawIdempotencyKey)
  }

  const requestHash = hashRequestPayload(req.body)

  if (scopedIdempotencyKey) {
    try {
      const cached = await getIdempotentResponse(scopedIdempotencyKey, requestHash, owner)
      if (cached) {
        try {
          assertValidMilestoneResponse(cached)
        } catch {
          return res.status(500).json({ error: 'Stored idempotency response is malformed' })
        }
        return res.status(200).json({ ...(cached as any), idempotency: { key: rawIdempotencyKey, replayed: true } })
      }
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: { code: 'IDEMPOTENCY_CONFLICT', message: error.message } })
      }
      if (error instanceof IdempotencyOwnerMismatchError) {
        return res.status(409).json({ error: { code: 'IDEMPOTENCY_OWNER_MISMATCH', message: error.message } })
      }
      return next(error)
    }
  }

  try {
    const result = await handler()
    assertValidMilestoneResponse(result.body)
    
    if (scopedIdempotencyKey) {
      await saveIdempotentResponse(scopedIdempotencyKey, requestHash, '', result.body, owner)
    }

    return res.status(result.status).json({ ...result.body, idempotency: { key: rawIdempotencyKey, replayed: false } })
  } catch (error) {
    if (scopedIdempotencyKey) {
      failPendingIdempotentResponse(scopedIdempotencyKey, requestHash, error, owner)
    }
    return next(error)
  }
}

// POST /api/vaults/:vaultId/milestones
milestonesRouter.post('/', authenticate, requireUser, requireValidVaultId, async (req: Request, res: Response, next: NextFunction) => {
  const actorUserId = resolveActorUserId(req)
  if (!actorUserId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
    return
  }

  const owner: OwnerContext = {
    userId: req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null,
    orgId: (req as any).apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? null,
  }

  await handleIdempotency(req, res, next, actorUserId, owner, async () => {
    const { vaultId } = req.params
    const vault = await getVaultById(vaultId)

    if (!vault) {
      throw AppError.notFound('Vault not found')
    }

    if (vault.status !== 'active') {
      throw AppError.conflict('Cannot add milestones to a non-active vault')
    }

    // Validate milestone fields using the same schema as vault creation.
    const parsed = parseMilestoneInput(req.body)
    if (!parsed.success) {
      throw AppError.badRequest('Invalid milestone payload', flattenZodErrors(parsed.error))
    }

    const { title, description, dueDate, amount } = parsed.data

    const { approvalThreshold = 1 } = req.body as { approvalThreshold?: number }
    if (!Number.isInteger(approvalThreshold) || approvalThreshold < 1) {
      throw AppError.badRequest('approvalThreshold must be a positive integer')
    }

    const milestone = createMilestoneWithThreshold(
      vaultId,
      // Use title + optional description as the canonical description stored on the record.
      description ? `${title}: ${description}` : title,
      approvalThreshold,
      vault.verifier,
    )
    return { status: 201, body: { ...milestone, title, description, dueDate, amount } }
  })
})

// GET /api/vaults/:vaultId/milestones
milestonesRouter.get('/', authenticate, requireValidVaultId, async (req: Request, res: Response, next: NextFunction) => {
  const { vaultId } = req.params
  const vault = await getVaultById(vaultId)

  if (!vault) {
    return next(AppError.notFound('Vault not found'))
  }

  const milestones = getMilestonesByVaultId(vaultId)
  res.json({ milestones })
})

// PATCH /api/vaults/:vaultId/milestones/:id/verify
milestonesRouter.patch('/:id/verify', authenticate, requireVerifier, requireValidVaultId, requireValidMilestoneId, async (req: Request, res: Response, next: NextFunction) => {
  const actorUserId = resolveActorUserId(req)
  if (!actorUserId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
    return
  }

  const owner: OwnerContext = {
    userId: req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null,
    orgId: (req as any).apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? null,
  }

  await handleIdempotency(req, res, next, actorUserId, owner, async () => {
    const { vaultId, id } = req.params

    const vault = await getVaultById(vaultId)
    if (!vault) {
      throw AppError.notFound('Vault not found')
    }

    const milestone = getMilestoneById(id)
    if (!milestone || milestone.vaultId !== vaultId) {
      throw AppError.notFound('Milestone not found')
    }

    const verified = verifyMilestone(id)
    if (!verified) {
      throw AppError.notFound('Milestone not found')
    }

    let vaultCompleted = false
    if (allMilestonesVerified(vaultId) && vault.status === 'active') {
      const trxResult = await db.transaction(async (trx) => {
        return await transitionVaultStatus(trx, vaultId, 'completed')
      })
      vaultCompleted = trxResult.success
    }

    return { status: 200, body: { milestone: verified, vaultCompleted } }
  })
})

const EVIDENCE_HASH_RE = /^[0-9a-f]{32,128}$/i

// POST /api/vaults/:vaultId/milestones/:id/validate
milestonesRouter.post('/:id/validate', authenticate, requireVerifier, requireValidVaultId, requireValidMilestoneId, async (req: Request, res: Response, next: NextFunction) => {
  const actorUserId = resolveActorUserId(req)
  if (!actorUserId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
    return
  }

  const owner: OwnerContext = {
    userId: req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null,
    orgId: (req as any).apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? null,
  }

  await handleIdempotency(req, res, next, actorUserId, owner, async () => {
    const { vaultId, id } = req.params
    const validatorUserId = actorUserId
    const { evidenceHash } = req.body as { evidenceHash?: string }

    if (!evidenceHash || !evidenceHash.trim()) {
      throw AppError.badRequest('evidenceHash is required')
    }

    const cleanEvidenceHash = evidenceHash.trim().toLowerCase()
    if (!EVIDENCE_HASH_RE.test(cleanEvidenceHash)) {
      throw AppError.validation('evidenceHash must be a valid hex string (32–128 characters)')
    }

    // Use DB-backed vault
    const vault = await getVaultById(vaultId)
    if (!vault) {
      throw AppError.notFound('Vault not found')
    }

    const milestone = getMilestoneById(id)
    if (!milestone || milestone.vaultId !== vaultId) {
      throw AppError.notFound('Milestone not found')
    }

    const result = validateMilestone(id, validatorUserId, cleanEvidenceHash)
    if (!result.success) {
      if (result.error === 'Milestone already validated') {
        throw AppError.conflict('Milestone already validated')
      }
      if (result.error === 'Unauthorized: only assigned verifier can validate') {
        throw AppError.forbidden('Unauthorized: only assigned verifier can validate')
      }
      throw AppError.badRequest(result.error!)
    }

    let vaultCompleted = false
    if (allMilestonesVerified(vaultId) && vault.status === 'active') {
      // Use DB-backed transition
      const trxResult = await db.transaction(async (trx) => {
        return await transitionVaultStatus(trx, vaultId, 'completed')
      })
      vaultCompleted = trxResult.success
    }

    return { status: 200, body: { milestone: result.milestone, vaultCompleted } }
  })
})

// POST /api/vaults/:vaultId/milestones/:id/approve
// Multi-verifier approval endpoint with duplicate-vote prevention
milestonesRouter.post('/:id/approve', authenticate, requireVerifier, requireValidVaultId, requireValidMilestoneId, async (req: Request, res: Response, next: NextFunction) => {
  const actorUserId = resolveActorUserId(req)
  if (!actorUserId) {
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } })
    return
  }

  const owner: OwnerContext = {
    userId: req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null,
    orgId: (req as any).apiKeyAuth?.orgId ?? req.user?.enterpriseId ?? null,
  }

  await handleIdempotency(req, res, next, actorUserId, owner, async () => {
    try {
      const { vaultId, id } = req.params
      const verifierUserId = actorUserId
      const { approvalStatus } = req.body as { approvalStatus?: string }

      // Validate input
      if (!approvalStatus || !['approved', 'rejected'].includes(approvalStatus)) {
        throw AppError.badRequest('approvalStatus must be "approved" or "rejected"')
      }

      // Check vault exists
      const vault = await getVaultById(vaultId)
      if (!vault) {
        throw AppError.notFound('Vault not found')
      }

      // Check milestone exists and belongs to vault
      const milestone = getMilestoneById(id)
      if (!milestone || milestone.vaultId !== vaultId) {
        throw AppError.notFound('Milestone not found')
      }

      // Reject approvals from non-active verifiers (historical votes remain intact).
      // Only `approved` verifiers may vote; pending, suspended, and deactivated
      // verifiers are excluded from the quorum.
      const verifier = await getVerifierProfile(verifierUserId)
      if (verifier && verifier.status !== 'approved') {
        throw AppError.forbidden('Only approved verifiers may cast milestone approvals')
      }

      // Check if verifier has already voted (duplicate vote prevention)
      const hasVoted = await hasVerifierVoted(id, verifierUserId)

      if (hasVoted) {
        throw AppError.conflict('Verifier has already voted on this milestone')
      }

      // Reject late votes on already-settled milestones (using cached milestone)
      const approvalThreshold = (milestone as any)?.approvalThreshold || 1
      const totalVerifiers = (milestone as any)?.totalVerifiers as number | undefined

      const priorProgress = await getMilestoneApprovalProgress(id, approvalThreshold, totalVerifiers)
      if (priorProgress.isComplete || priorProgress.isRejected) {
        throw AppError.conflict('Milestone is already settled')
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
          // Use DB-backed transition
          const trxResult = await db.transaction(async (trx) => {
            return await transitionVaultStatus(trx, vaultId, 'completed')
          })
          vaultCompleted = trxResult.success
        }
      }

      return {
        status: 201,
        body: {
          approval,
          approvalProgress,
          milestone: {
            ...milestone,
            approvalThreshold,
          },
          milestoneCompleted,
          vaultCompleted,
        }
      }
    } catch (error) {
      if (error instanceof DuplicateVerifierVoteError) {
        throw AppError.conflict(error.message)
      }
      throw error
    }
  })
})

// GET /api/vaults/:vaultId/milestones/:id/approval-status
// Get detailed approval status for a milestone (requires authentication)
milestonesRouter.get('/:id/approval-status', authenticate, requireValidVaultId, requireValidMilestoneId, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { vaultId, id } = req.params

    // Check vault exists
    const vault = await getVaultById(vaultId)
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
