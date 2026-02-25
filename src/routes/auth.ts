import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { revokeSession, revokeAllUserSessions } from '../services/session.js'

export const authRouter = Router()

/**
 * Logout of the current session
 */
authRouter.post('/logout', authenticate, async (req: Request, res: Response) => {
  const jti = req.user?.jti
  if (!jti) {
    res.status(401).json({ error: 'No active session' })
    return
  }

  await revokeSession(jti)
  res.json({ message: 'Successfully logged out' })
})

/**
 * Logout of all active sessions for the current user
 */
authRouter.post('/logout-all', authenticate, async (req: Request, res: Response) => {
  const userId = req.user?.sub
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  await revokeAllUserSessions(userId)
  res.json({ message: 'Successfully logged out from all devices' })
})
