import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { createOrGetVerifierProfile, listVerifierProfiles, getVerifierProfile, setVerifierStatus, getVerifierStats } from '../services/verifiers.js'

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
