import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireVerifier, requireAdmin } from '../middleware/rbac.js'
import {
  createValidationTransaction,
  findValidationTransactionById,
  IdempotencyConflictError,
  listValidationTransactions,
  type ValidationPayload,
  type ValidationTransactionRecord,
} from '../services/verifications.js'
import { recordVerification, listVerifications } from '../services/verifiers.js'

export const verificationsRouter = Router()

const toApiResponse = (record: ValidationTransactionRecord, replayed: boolean) => ({
  id: record.id,
  vaultId: record.vaultId,
  milestoneId: record.milestoneId,
  verdict: record.verdict,
  reason: record.reason,
  verifierId: record.verifierId,
  createdAt: record.createdAt,
  replayed,
  evidence: {
    mimeType: record.evidence.mimeType,
    sizeBytes: record.evidence.sizeBytes,
    encrypted: true,
    algorithm: record.evidence.algorithm,
    keyId: record.evidence.keyId,
  },
})

const isValidationPayload = (value: unknown): value is ValidationPayload => {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Record<string, unknown>
  const evidence = candidate.evidence as Record<string, unknown> | undefined

  return (
    typeof candidate.vaultId === 'string' &&
    candidate.vaultId.trim().length > 0 &&
    typeof candidate.milestoneId === 'string' &&
    candidate.milestoneId.trim().length > 0 &&
    (candidate.verdict === 'approved' || candidate.verdict === 'rejected') &&
    (!candidate.reason || typeof candidate.reason === 'string') &&
    !!evidence &&
    typeof evidence.mimeType === 'string' &&
    evidence.mimeType.trim().length > 0 &&
    typeof evidence.data === 'string' &&
    evidence.data.trim().length > 0
  )
}

verificationsRouter.post('/', authenticate, requireVerifier, async (req: Request, res: Response) => {
  const payload = req.user!
  const verifierUserId = payload.userId
  const { targetId, result, disputed } = req.body as {
    targetId?: string
    result?: 'approved' | 'rejected'
    disputed?: boolean
  }

  if (!targetId || !targetId.trim()) {
    res.status(400).json({ error: 'targetId is required' })
    return
  }

  if (result !== 'approved' && result !== 'rejected') {
    res.status(400).json({ error: "result must be 'approved' or 'rejected'" })
    return
  }

  const rec = await recordVerification(verifierUserId, targetId.trim(), result, !!disputed)
  res.status(201).json({ verification: rec })
})

verificationsRouter.get('/', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const all = await listVerifications()
  res.json({ verifications: all })
})

verificationsRouter.post('/validations', authenticate, requireVerifier, (req, res) => {
  const idempotencyKey = req.header('idempotency-key')?.trim()
  if (!idempotencyKey) {
    res.status(400).json({ error: 'Missing required Idempotency-Key header.' })
    return
  }

  if (!isValidationPayload(req.body)) {
    res.status(400).json({
      error:
        'Invalid payload. Required fields: vaultId, milestoneId, verdict ("approved"|"rejected"), evidence { mimeType, data }.',
    })
    return
  }

  try {
    const { record, replayed } = createValidationTransaction(req.body, req.user!.userId, idempotencyKey)
    res.status(replayed ? 200 : 201).json(toApiResponse(record, replayed))
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      res.status(409).json({ error: error.message })
      return
    }
    throw error
  }
})

verificationsRouter.get('/validations', authenticate, requireVerifier, (_req, res) => {
  const records = listValidationTransactions().map((record) => toApiResponse(record, false))
  res.json({ records, count: records.length })
})

verificationsRouter.get('/validations/:id', authenticate, requireVerifier, (req, res) => {
  const record = findValidationTransactionById(req.params.id)
  if (!record) {
    res.status(404).json({ error: 'Validation transaction not found.' })
    return
  }

  res.json(toApiResponse(record, false))
})
