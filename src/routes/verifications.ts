import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireVerifier, requireAdmin } from '../middleware/rbac.js'
import { recordVerification, listVerifications } from '../services/verifiers.js'

export const verificationsRouter = Router()

verificationsRouter.post('/', authenticate, requireVerifier, async (req: Request, res: Response) => {
  const payload = req.user!
  const verifierUserId = payload.sub
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

// Admin: list all verification records
verificationsRouter.get('/', authenticate, requireAdmin, async (_req: Request, res: Response) => {
  const all = await listVerifications()
  res.json({ verifications: all })
})
