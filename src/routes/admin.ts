import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { forceRevokeUserSessions } from '../services/session.js'

export const adminRouter = Router()

/**
 * Force-logout a user (Admin only)
 */
adminRouter.post('/users/:userId/revoke-sessions', authenticate, requireAdmin, async (req: Request, res: Response) => {
  const { userId } = req.params
  
  if (!userId) {
    res.status(400).json({ error: 'Missing userId' })
    return
  }

  await forceRevokeUserSessions(userId)
  res.json({ message: `All sessions for user ${userId} have been revoked` })
})
