import { Router, Request, Response, type NextFunction } from 'express'
import { randomUUID } from 'node:crypto'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import {
  VerifierStatus,
  createOrGetVerifierProfile,
  createVerifierProfile,
  deleteVerifierProfile,
  getVerifierProfile,
  getVerifierStats,
  listVerifierProfiles,
  InvalidVerifierStatusTransitionError,
  transitionVerifier,
  updateVerifierProfile,
} from '../services/verifiers.js'
import { isValidStellarAddress } from '../services/vaultValidation.js'
import { AppError } from '../middleware/errorHandler.js'

const MAX_USER_ID_LENGTH = 128

/**
 * Hard upper bound on the number of verifier profiles returned per page.
 * Prevents unbounded result sets that would exhaust memory or DB cursors.
 */
const MAX_PAGE_LIMIT = 200

/** Guard against excessively long or whitespace-only userId path params. */
const sanitizeUserId = (raw: string): string | null => {
  const trimmed = raw.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_USER_ID_LENGTH) return null
  return trimmed
}

/**
 * Emit a structured JSON diagnostic event to stderr.
 * Fields are sanitised: no user-controlled values reach the message string
 * and no secrets or PII are included.
 */
function emitDiagnostic(event: {
  level: 'info' | 'warn' | 'error'
  action: string
  requestId: string
  actorUserId?: string
  targetUserId?: string
  latencyMs?: number
  outcome?: string
  errorCode?: string
  fromStatus?: string
  toStatus?: string
}): void {
  const entry: Record<string, unknown> = {
    level: event.level,
    service: 'disciplr-backend',
    component: 'adminVerifiers',
    action: event.action,
    requestId: event.requestId,
    timestamp: new Date().toISOString(),
  }
  if (event.actorUserId !== undefined) entry.actorUserId = event.actorUserId
  if (event.targetUserId !== undefined) entry.targetUserId = event.targetUserId
  if (event.latencyMs !== undefined) entry.latencyMs = event.latencyMs
  if (event.outcome !== undefined) entry.outcome = event.outcome
  if (event.errorCode !== undefined) entry.errorCode = event.errorCode
  if (event.fromStatus !== undefined) entry.fromStatus = event.fromStatus
  if (event.toStatus !== undefined) entry.toStatus = event.toStatus
  console.error(JSON.stringify(entry))
}

export const adminVerifiersRouter = Router()

adminVerifiersRouter.use(authenticate, requireAdmin)

adminVerifiersRouter.get('/', async (_req: Request, res: Response) => {
  // Enforce an upper bound on `limit` to prevent unbounded result sets.
  // Default: 50 items. Maximum: MAX_PAGE_LIMIT (200).
  const rawLimit = getStringQuery(_req.query.limit) ? Number(getStringQuery(_req.query.limit)) : 50
  const limit = Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50, MAX_PAGE_LIMIT)
  const rawOffset = getStringQuery(_req.query.offset) ? Number(getStringQuery(_req.query.offset)) : 0
  const offset = Number.isFinite(rawOffset) && rawOffset >= 0 ? Math.floor(rawOffset) : 0

  const profiles = await listVerifierProfiles({ limit, offset })
  const withStats = await Promise.all(profiles.map(async (p) => ({ profile: p, stats: await getVerifierStats(p.userId) })))
  res.json({
    verifiers: withStats,
    pagination: {
      limit,
      offset,
      count: profiles.length,
      hasMore: profiles.length === limit,
    },
  })
})

adminVerifiersRouter.get('/:userId', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  const p = await getVerifierProfile(userId)
  if (!p) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }
  res.json({ profile: p, stats: await getVerifierStats(userId) })
})

adminVerifiersRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const { userId, displayName, metadata, status, reason } = req.body as {
    userId?: unknown
    displayName?: unknown
    metadata?: unknown
    status?: unknown
    reason?: unknown
  }

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    res.status(400).json({ error: 'userId is required' })
    return
  }

  // If userId appears to be a Stellar address, ensure checksum is valid
  try {
    if (userId && typeof userId === 'string' && !(await isValidStellarAddress(userId.trim()))) {
      return next(AppError.validation('invalid Stellar public key', { field: 'userId' }))
    }
  } catch (err) {
    return next(AppError.internal('address validation failed'))
  }

  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName must be a string when provided' })
    return
  }

  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    res.status(400).json({ error: 'metadata must be an object when provided' })
    return
  }

  if (status !== undefined && !isVerifierStatus(status)) {
    res.status(400).json({ error: 'invalid status' })
    return
  }
  
  const parsedReason = typeof reason === 'string' ? reason.trim() : undefined

  try {
    const profile = await createVerifierProfile(userId.trim(), {
      displayName: typeof displayName === 'string' ? displayName.trim() : undefined,
      metadata: isRecord(metadata) ? metadata : undefined,
      status: isVerifierStatus(status) ? status : undefined,
    }, { actorUserId: req.user!.userId, reason: parsedReason })

    const stats = await getVerifierStats(profile.after.userId)
    res.status(201).json({ profile: profile.after, stats, auditLogId: profile.auditLog?.id })
  } catch (error) {
    if (isDuplicateError(error)) {
      res.status(409).json({ error: 'verifier already exists' })
      return
    }
    res.status(500).json({ error: 'internal server error' })
  }
})

adminVerifiersRouter.patch('/:userId', async (req: Request, res: Response) => {
  const userId = req.params.userId
  const { displayName, metadata, status, reason } = req.body as {
    displayName?: unknown
    metadata?: unknown
    status?: unknown
    reason?: unknown
  }

  if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') {
    res.status(400).json({ error: 'displayName must be a string when provided' })
    return
  }

  if (metadata !== undefined && metadata !== null && (typeof metadata !== 'object' || Array.isArray(metadata))) {
    res.status(400).json({ error: 'metadata must be an object when provided' })
    return
  }

  if (status !== undefined && !isVerifierStatus(status)) {
    res.status(400).json({ error: 'invalid status' })
    return
  }

  const parsedReason = typeof reason === 'string' ? reason.trim() : undefined

  let profile
  try {
    profile = await updateVerifierProfile(userId, {
      displayName: typeof displayName === 'string' ? displayName.trim() : displayName === null ? null : undefined,
      metadata: isRecord(metadata) ? metadata : metadata === null ? null : undefined,
      status: isVerifierStatus(status) ? status : undefined,
    }, { actorUserId: req.user!.userId, reason: parsedReason })
  } catch (error) {
    if (error instanceof InvalidVerifierStatusTransitionError) {
      res.status(409).json({ error: error.message })
      return
    }
    res.status(500).json({ error: 'internal server error' })
    return
  }

  if (!profile) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }

  const stats = await getVerifierStats(userId)
  res.json({ profile: profile.after, stats, auditLogId: profile.auditLog?.id ?? null, changedFields: profile.changedFields })
})

adminVerifiersRouter.delete('/:userId', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined
  const result = await deleteVerifierProfile(userId, { actorUserId: req.user!.userId, reason })

  if (!result.deleted) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }

  res.status(204).send()
})

adminVerifiersRouter.post('/:userId/approve', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  await createOrGetAndTransitionStatus(req, res, userId, 'approved')
})

adminVerifiersRouter.post('/:userId/suspend', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  await createOrGetAndTransitionStatus(req, res, userId, 'suspended')
})

// POST /api/admin/verifiers/:userId/reinstate
// Restores a verifier back to their prior active state:
// - if they were previously approved, restore to approved
// - otherwise restore to pending
adminVerifiersRouter.post('/:userId/reinstate', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }

  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
  const t0 = Date.now()

  try {
    const verifier = await getVerifierProfile(userId)
    if (!verifier) {
      res.setHeader('X-Request-Id', requestId)
      res.status(404).json({ error: 'verifier not found' })
      return
    }

    // Early-return if the verifier is already in an active state.
    if (verifier.status === 'approved' || verifier.status === 'pending') {
      emitDiagnostic({
        level: 'info',
        action: 'verifier.reinstate',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        latencyMs: Date.now() - t0,
        outcome: 'already_active',
        fromStatus: verifier.status,
        toStatus: verifier.status,
      })
      res.setHeader('X-Request-Id', requestId)
      res.json({
        profile: verifier,
        stats: await getVerifierStats(userId),
        auditLogId: null,
        changedFields: [],
      })
      return
    }

    const nextStatus: VerifierStatus = verifier.approvedAt ? 'approved' : 'pending'

    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined
    const updated = await transitionVerifier(userId, nextStatus, { actorUserId: req.user!.userId, reason })


    if (!updated) {
      res.setHeader('X-Request-Id', requestId)
      res.status(404).json({ error: 'verifier not found' })
      return
    }

    emitDiagnostic({
      level: 'info',
      action: 'verifier.reinstate',
      requestId,
      actorUserId: req.user!.userId,
      targetUserId: userId,
      latencyMs: Date.now() - t0,
      outcome: 'success',
      fromStatus: verifier.status,
      toStatus: updated.after.status,
    })

    res.setHeader('X-Request-Id', requestId)
    res.json({
      profile: updated.after,
      stats: await getVerifierStats(userId),
      auditLogId: updated.auditLog?.id ?? null,
      changedFields: updated.changedFields,
    })
  } catch (error) {
    if (error instanceof InvalidVerifierStatusTransitionError) {
      emitDiagnostic({
        level: 'warn',
        action: 'verifier.reinstate',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        latencyMs: Date.now() - t0,
        outcome: 'invalid_transition',
        errorCode: 'INVALID_TRANSITION',
        fromStatus: error.from,
        toStatus: error.to,
      })
      res.setHeader('X-Request-Id', requestId)
      res.status(409).json({ error: error.message })
      return
    }

    emitDiagnostic({
      level: 'error',
      action: 'verifier.reinstate',
      requestId,
      actorUserId: req.user!.userId,
      targetUserId: userId,
      latencyMs: Date.now() - t0,
      outcome: 'error',
      errorCode: 'INTERNAL_ERROR',
    })
    res.status(500).json({ error: 'internal server error' })
  }
})

adminVerifiersRouter.post('/:userId/deactivate', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  await transitionStatus(req, res, userId, 'deactivated')
})

adminVerifiersRouter.post('/:userId/reactivate', async (req: Request, res: Response) => {
  const userId = sanitizeUserId(req.params.userId)
  if (!userId) {
    res.status(400).json({ error: 'invalid userId' })
    return
  }
  await transitionStatus(req, res, userId, 'pending')
})

const isVerifierStatus = (value: unknown): value is VerifierStatus =>
  value === 'pending' || value === 'approved' || value === 'suspended' || value === 'deactivated'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isDuplicateError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') {
    return false
  }

  const maybeErr = error as { code?: string; constraint?: string; message?: string }
  return maybeErr.code === '23505'
    || maybeErr.code === 'SQLITE_CONSTRAINT'
    || maybeErr.constraint === 'verifiers_pkey'
    || maybeErr.message?.toLowerCase().includes('unique') === true
}

const transitionStatus = async (req: Request, res: Response, userId: string, status: VerifierStatus): Promise<void> => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()
  const t0 = Date.now()
  try {
    const current = await getVerifierProfile(userId)
    const fromStatus = current?.status

    const updated = await transitionVerifier(userId, status, { actorUserId: req.user!.userId, reason })
    if (!updated) {
      emitDiagnostic({
        level: 'warn',
        action: 'verifier.transition',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        latencyMs: Date.now() - t0,
        outcome: 'not_found',
        toStatus: status,
      })
      res.status(404).json({ error: 'verifier not found' })
      return
    }

    emitDiagnostic({
      level: 'info',
      action: 'verifier.transition',
      requestId,
      actorUserId: req.user!.userId,
      targetUserId: userId,
      latencyMs: Date.now() - t0,
      outcome: 'success',
      fromStatus: fromStatus ?? 'unknown',
      toStatus: updated.after.status,
    })

    res.setHeader('X-Request-Id', requestId)
    res.json({
      profile: updated.after,
      stats: await getVerifierStats(userId),
      auditLogId: updated.auditLog?.id ?? null,
      changedFields: updated.changedFields,
    })
  } catch (error) {
    if (error instanceof InvalidVerifierStatusTransitionError) {
      emitDiagnostic({
        level: 'warn',
        action: 'verifier.transition',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        latencyMs: Date.now() - t0,
        outcome: 'invalid_transition',
        errorCode: 'INVALID_TRANSITION',
        fromStatus: error.from,
        toStatus: error.to,
      })
      res.setHeader('X-Request-Id', requestId)
      res.status(409).json({ error: error.message })
      return
    }

    emitDiagnostic({
      level: 'error',
      action: 'verifier.transition',
      requestId,
      actorUserId: req.user!.userId,
      targetUserId: userId,
      latencyMs: Date.now() - t0,
      outcome: 'error',
      errorCode: 'INTERNAL_ERROR',
      toStatus: status,
    })
    res.status(500).json({ error: 'internal server error' })
  }
}

/**
 * In-flight transition guard: tracks userId keys that are currently being
 * transitioned to prevent duplicate concurrent mutations from the same actor.
 * Cleared on completion or error. This is process-local; for multi-replica
 * deployments a distributed lock (e.g. Redis SETNX) is needed.
 */
const inFlightTransitions = new Set<string>()

const createOrGetAndTransitionStatus = async (req: Request, res: Response, userId: string, status: VerifierStatus): Promise<void> => {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : undefined
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID()

  // Guard against duplicate concurrent transitions for the same verifier.
  if (inFlightTransitions.has(userId)) {
    emitDiagnostic({
      level: 'warn',
      action: 'verifier.transition',
      requestId,
      actorUserId: req.user!.userId,
      targetUserId: userId,
      outcome: 'concurrent_request_rejected',
      toStatus: status,
    })
    res.setHeader('X-Request-Id', requestId)
    res.status(429).json({ error: 'concurrent transition in progress for this verifier; retry after the current request completes' })
    return
  }

  inFlightTransitions.add(userId)
  try {
    const existing = await getVerifierProfile(userId)
    if (!existing) {
      const profile = await createVerifierProfile(userId, { status }, { actorUserId: req.user!.userId, reason })
      emitDiagnostic({
        level: 'info',
        action: 'verifier.transition',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        outcome: 'created_with_status',
        toStatus: status,
      })
      res.setHeader('X-Request-Id', requestId)
      res.json({
        profile: profile.after,
        stats: await getVerifierStats(userId),
        auditLogId: profile.auditLog?.id ?? null,
        changedFields: profile.changedFields,
      })
      return
    }
  } catch (error) {
    if (isDuplicateError(error)) {
      // Fallthrough to transition if created concurrently
    } else {
      emitDiagnostic({
        level: 'error',
        action: 'verifier.transition',
        requestId,
        actorUserId: req.user!.userId,
        targetUserId: userId,
        outcome: 'error',
        errorCode: 'INTERNAL_ERROR',
        toStatus: status,
      })
      res.status(500).json({ error: 'internal server error' })
      return
    }
  } finally {
    inFlightTransitions.delete(userId)
  }

  await transitionStatus(req, res, userId, status)
}

const getStringQuery = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined

