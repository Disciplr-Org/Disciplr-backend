import { Router, Request, Response } from 'express'
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
  setVerifierStatus,
  updateVerifierProfile,
} from '../services/verifiers.js'

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

adminVerifiersRouter.post('/', async (req: Request, res: Response) => {
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
    })

    const stats = await getVerifierStats(profile.userId)
    console.info(JSON.stringify({ level: 'info', event: 'admin.verifier_profile.created', userIdPrefix: maskUserId(profile.userId) }))
    res.status(201).json({ profile, stats })
  } catch (error) {
    if (isDuplicateError(error)) {
      res.status(409).json({ error: 'verifier already exists' })
      return
    }

    console.error(JSON.stringify({ level: 'error', event: 'admin.verifier_profile.create_failed' }))
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

  const profile = await updateVerifierProfile(userId, {
    displayName: typeof displayName === 'string' ? displayName.trim() : displayName === null ? null : undefined,
    metadata: isRecord(metadata) ? metadata : metadata === null ? null : undefined,
    status: isVerifierStatus(status) ? status : undefined,
  })

  if (!profile) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }

  const stats = await getVerifierStats(userId)
  console.info(JSON.stringify({ level: 'info', event: 'admin.verifier_profile.updated', userIdPrefix: maskUserId(userId) }))
  res.json({ profile, stats })
})

adminVerifiersRouter.delete('/:userId', async (req: Request, res: Response) => {
  const userId = req.params.userId
  const deleted = await deleteVerifierProfile(userId)

  if (!deleted) {
    res.status(404).json({ error: 'verifier not found' })
    return
  }

  console.info(JSON.stringify({ level: 'info', event: 'admin.verifier_profile.deleted', userIdPrefix: maskUserId(userId) }))
  res.status(204).send()
})

adminVerifiersRouter.post('/:userId/approve', async (req: Request, res: Response) => {
  const userId = req.params.userId
  await createOrGetVerifierProfile(userId)
  const updated = await setVerifierStatus(userId, 'approved')
  res.json({ profile: updated, stats: await getVerifierStats(userId) })
})

adminVerifiersRouter.post('/:userId/suspend', async (req: Request, res: Response) => {
  const userId = req.params.userId
  await createOrGetVerifierProfile(userId)
  const updated = await setVerifierStatus(userId, 'suspended')
  res.json({ profile: updated, stats: await getVerifierStats(userId) })
})

const isVerifierStatus = (value: unknown): value is VerifierStatus =>
  value === 'pending' || value === 'approved' || value === 'suspended'

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

const maskUserId = (userId: string): string => (userId.length <= 8 ? userId : userId.slice(0, 8))
