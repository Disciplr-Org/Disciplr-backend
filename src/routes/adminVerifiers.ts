import { Router, Request, Response, type NextFunction } from 'express'
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

export const adminVerifiersRouter = Router()

adminVerifiersRouter.use(authenticate, requireAdmin)

adminVerifiersRouter.get('/', async (_req: Request, res: Response) => {
  const profiles = await listVerifierProfiles()
  const withStats = await Promise.all(profiles.map(async (p) => ({ profile: p, stats: await getVerifierStats(p.userId) })))
  res.json({ verifiers: withStats })
})

adminVerifiersRouter.get('/:userId', async (req: Request, res: Response) => {
  const userId = req.params.userId
  const p = await getVerifierProfile(userId)
  if (!p) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }
  res.json({ profile: p, stats: await getVerifierStats(userId) })
})

adminVerifiersRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const { userId, displayName, metadata, status } = req.body as {
    userId?: unknown
    displayName?: unknown
    metadata?: unknown
    status?: unknown
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

  try {
    const profile = await createVerifierProfile(userId.trim(), {
      displayName: typeof displayName === 'string' ? displayName.trim() : undefined,
      metadata: isRecord(metadata) ? metadata : undefined,
      status: isVerifierStatus(status) ? status : undefined,
    }, { actorUserId: req.user!.userId })

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
  const { displayName, metadata, status } = req.body as {
    displayName?: unknown
    metadata?: unknown
    status?: unknown
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

  let profile
  try {
    profile = await updateVerifierProfile(userId, {
      displayName: typeof displayName === 'string' ? displayName.trim() : displayName === null ? null : undefined,
      metadata: isRecord(metadata) ? metadata : metadata === null ? null : undefined,
      status: isVerifierStatus(status) ? status : undefined,
    }, { actorUserId: req.user!.userId })
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
  const userId = req.params.userId
  const result = await deleteVerifierProfile(userId, { actorUserId: req.user!.userId })

  if (!result.deleted) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }

  res.status(204).send()
})

adminVerifiersRouter.post('/:userId/approve', async (req: Request, res: Response) => {
  await createOrGetAndTransitionStatus(req, res, req.params.userId, 'approved')
})

adminVerifiersRouter.post('/:userId/suspend', async (req: Request, res: Response) => {
  await createOrGetAndTransitionStatus(req, res, req.params.userId, 'suspended')
})

// POST /api/admin/verifiers/:userId/reinstate
// Restores a verifier back to their prior active state:
// - if they were previously approved, restore to approved
// - otherwise restore to pending
adminVerifiersRouter.post('/:userId/reinstate', async (req: Request, res: Response) => {
  try {
    const verifier = await getVerifierProfile(req.params.userId)
    if (!verifier) {
      res.status(404).json({ error: 'verifier not found' })
      return
    }


    const nextStatus: VerifierStatus = verifier.approvedAt ? 'approved' : 'pending'

    const updated = await transitionVerifier(req.params.userId, nextStatus, { actorUserId: req.user!.userId })


    if (!updated) {
      res.status(404).json({ error: 'verifier not found' })
      return
    }

    res.json({
      profile: updated.after,
      stats: await getVerifierStats(req.params.userId),
      auditLogId: updated.auditLog?.id ?? null,
      changedFields: updated.changedFields,
    })
  } catch (error) {
    if (error instanceof InvalidVerifierStatusTransitionError) {
      res.status(409).json({ error: error.message })
      return
    }

    res.status(500).json({ error: 'internal server error' })
  }
})

adminVerifiersRouter.post('/:userId/deactivate', async (req: Request, res: Response) => {
  await transitionStatus(req, res, req.params.userId, 'deactivated')
})

adminVerifiersRouter.post('/:userId/reactivate', async (req: Request, res: Response) => {
  await transitionStatus(req, res, req.params.userId, 'pending')
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
  try {
    const updated = await transitionVerifier(userId, status, { actorUserId: req.user!.userId })
    if (!updated) {
      res.status(404).json({ error: 'verifier not found' })
      return
    }
    res.json({
      profile: updated.after,
      stats: await getVerifierStats(userId),
      auditLogId: updated.auditLog?.id ?? null,
      changedFields: updated.changedFields,
    })
  } catch (error) {
    if (error instanceof InvalidVerifierStatusTransitionError) {
      res.status(409).json({ error: error.message })
      return
    }

    res.status(500).json({ error: 'internal server error' })
  }
}

const createOrGetAndTransitionStatus = async (req: Request, res: Response, userId: string, status: VerifierStatus): Promise<void> => {
  try {
    await createOrGetVerifierProfile(userId, undefined, { actorUserId: req.user!.userId })
  } catch {
    res.status(500).json({ error: 'internal server error' })
    return
  }

  await transitionStatus(req, res, userId, status)
}

