import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireVerifier, requireAdmin } from '../middleware/rbac.js'
import { recordVerification, listVerifications } from '../services/verifiers.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'
import { createEvidenceReference, EvidenceReferenceValidationError } from '../services/evidence.js'

export const verificationsRouter = Router()

const EVIDENCE_HASH_RE = /^[0-9a-f]{32,128}$/i

verificationsRouter.post('/', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  const payload = req.user!
  const verifierUserId = payload.userId
  const { targetId, result, disputed, evidenceHash } = req.body as {
    targetId?: string
    result?: 'approved' | 'rejected'
    disputed?: boolean
    evidenceHash?: string
  }

  if (!targetId || !targetId.trim()) {
    return next(AppError.badRequest('targetId is required'))
  }

  if (result !== 'approved' && result !== 'rejected') {
    return next(AppError.validation("result must be 'approved' or 'rejected'"))
  }

  if (!evidenceHash || !evidenceHash.trim()) {
    return next(AppError.badRequest('evidenceHash is required'))
  }

  const cleanEvidenceHash = evidenceHash.trim().toLowerCase()
  if (!EVIDENCE_HASH_RE.test(cleanEvidenceHash)) {
    return next(AppError.validation('evidenceHash must be a valid hex string (32–128 characters)'))
  }

  try {
    const cleanTargetId = targetId.trim()

    const rec = await recordVerification(
      verifierUserId,
      cleanTargetId,
      result,
      !!disputed,
      cleanEvidenceHash,
    )

    const evidenceReference = await createEvidenceReference(
      rec.id,
      evidenceHash.trim(),
      evidenceReferenceUrl.trim(),
    )

    createAuditLog({
      actor_user_id: verifierUserId,
      action: 'verification.decision.recorded',
      target_type: 'verification',
      target_id: cleanTargetId,
      metadata: {
        result,
        disputed: !!disputed,
        evidence_hash: cleanEvidenceHash,
      },
    })

    res.status(201).json({ verification: rec, evidenceReference })
  } catch (error: any) {
    if (error?.name === 'VerificationConflictError') {
      return next(AppError.conflict('conflicting verification decision already exists'))
    }

    if (error?.name === 'EvidenceReferenceValidationError') {
      return next(AppError.validation(error.message))
    }

    return next(AppError.internal('failed to record verification decision'))
  }
})

verificationsRouter.get('/', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const all = await listVerifications()
  res.json({ verifications: all })
})