import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireVerifier, requireAdmin } from '../middleware/rbac.js'
import { recordVerification, listVerifications } from '../services/verifiers.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'

export const verificationsRouter = Router()

verificationsRouter.post('/', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  const payload = req.user!
  const verifierUserId = payload.userId
  const { targetId, result, disputed } = req.body as {
    targetId?: string
    result?: 'approved' | 'rejected'
    disputed?: boolean
  }

  if (!targetId || !targetId.trim()) {
    return next(AppError.badRequest('targetId is required'))
  }

  if (result !== 'approved' && result !== 'rejected') {
    return next(AppError.validation("result must be 'approved' or 'rejected'"))
  }

  try {
    const cleanTargetId = targetId.trim()

    const rec = await recordVerification(
      verifierUserId,
      cleanTargetId,
      result,
      !!disputed
    )

    createAuditLog({
      actor_user_id: verifierUserId,
      action: 'verification.decision.recorded',
      target_type: 'verification',
      target_id: cleanTargetId,
      metadata: {
        result,
        disputed: !!disputed,
      },
    })

    res.status(201).json({ verification: rec })
  } catch (error: any) {
    if (error?.name === 'VerificationConflictError') {
      return next(AppError.conflict('conflicting verification decision already exists'))
    }

    return next(AppError.internal('failed to record verification decision'))
  }
})

verificationsRouter.get('/', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const all = await listVerifications()
  res.json({ verifications: all })
})