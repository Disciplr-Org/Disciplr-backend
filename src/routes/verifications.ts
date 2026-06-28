import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireVerifier, requireAdmin } from '../middleware/rbac.js'
import { recordVerification, listVerifications } from '../services/verifiers.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'
import { createEvidenceReference, EvidenceReferenceValidationError } from '../services/evidence.js'
import { db } from '../db/knex.js'
import { retryWithBackoff } from '../utils/retry.js'
import {
  getIdempotentResponse,
  hashRequestPayload,
  saveIdempotentResponse,
  failPendingIdempotentResponse,
  IdempotencyConflictError,
  validateIdempotencyKey,
  scopeIdempotencyKey,
} from '../services/idempotency.js'

export const verificationsRouter = Router()

const EVIDENCE_HASH_RE = /^[0-9a-f]{32,128}$/i

function isSerializationError(err: Error): boolean {
  const msg = err.message.toLowerCase()
  return msg.includes('serialization') || msg.includes('could not serialize') || msg.includes('deadlock')
}

verificationsRouter.post('/', authenticate, requireVerifier, async (req: Request, res: Response, next: NextFunction) => {
  const payload = req.user!
  const verifierUserId = payload.userId

  const rawIdempotencyKey = req.header('idempotency-key') ?? null
  let scopedIdempotencyKey: string | null = null

  if (rawIdempotencyKey) {
    const validation = validateIdempotencyKey(rawIdempotencyKey)
    if (!validation.valid) {
      return res.status(400).json({
        error: {
          code: validation.code,
          message: validation.error,
        },
      })
    }
    scopedIdempotencyKey = scopeIdempotencyKey(verifierUserId, rawIdempotencyKey)
  }

  const requestHash = hashRequestPayload(req.body)

  if (scopedIdempotencyKey) {
    try {
      const cached = await getIdempotentResponse<{ verification: any; evidenceReference: any }>(scopedIdempotencyKey, requestHash)
      if (cached !== null) {
        res.status(200).json({ ...cached, idempotency: { key: rawIdempotencyKey, replayed: true } })
        return
      }
    } catch (err) {
      if (err instanceof IdempotencyConflictError) {
        res.status(409).json({
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: err.message,
          },
        })
        return
      }
      throw err
    }
  }

  const { targetId, result, disputed, evidenceHash, evidenceReferenceUrl } = req.body as {
    targetId?: string
    result?: 'approved' | 'rejected'
    disputed?: boolean
    evidenceHash?: string
    evidenceReferenceUrl?: string
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

  if (!evidenceReferenceUrl || !evidenceReferenceUrl.trim()) {
    return next(AppError.badRequest('evidenceReferenceUrl is required'))
  }

  try {
    const cleanTargetId = targetId.trim()

    const rec = await retryWithBackoff(
      () =>
        db.transaction(async (trx) => {
          const verification = await recordVerification(
            verifierUserId,
            cleanTargetId,
            result,
            !!disputed,
            cleanEvidenceHash,
            trx,
          )

          await createAuditLog(
            {
              actor_user_id: verifierUserId,
              action: 'verification.decision.recorded',
              target_type: 'verification',
              target_id: cleanTargetId,
              metadata: {
                result,
                disputed: !!disputed,
                evidence_hash: cleanEvidenceHash,
              },
            },
            trx,
          )

          return verification
        }),
      undefined,
      isSerializationError,
    )

    const evidenceReference = await createEvidenceReference(
      rec.id,
      evidenceHash.trim(),
      evidenceReferenceUrl.trim(),
    )

    const responseBody: { verification: typeof rec; evidenceReference: typeof evidenceReference; idempotency?: { key: string | null; replayed: boolean } } = { verification: rec, evidenceReference }
    if (scopedIdempotencyKey) {
      responseBody.idempotency = { key: rawIdempotencyKey, replayed: false }
      await saveIdempotentResponse(scopedIdempotencyKey, requestHash, rec.id, responseBody)
    }

    res.status(201).json(responseBody)
  } catch (error: any) {
    if (scopedIdempotencyKey) {
      failPendingIdempotentResponse(scopedIdempotencyKey, requestHash, error)
    }

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
