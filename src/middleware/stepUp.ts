import { NextFunction, Request, Response } from 'express'
import { AuthService } from '../services/auth.service.js'

export const requireStepUp = (maxAgeSeconds = 300, actionResolver?: (req: Request) => string | undefined) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const userId = (req as any).user?.userId ?? (req as any).authUser?.userId
    const sessionId =
      (req.headers['x-step-up-session-id'] as string | undefined) ??
      (req.body as any)?.stepUpSessionId ??
      (req.query as any)?.stepUpSessionId

    if (!userId || !sessionId) {
      return res.status(401).json({
        error: 'Step-up authentication required',
        challenge: '/api/auth/webauthn/challenge',
        stepUpRequired: true,
      })
    }

    const action = actionResolver ? actionResolver(req) : undefined
    const verifiedSession = await AuthService.validateStepUpSession(sessionId, maxAgeSeconds, action)
    if (!verifiedSession || verifiedSession.userId !== userId) {
      return res.status(401).json({
        error: 'Step-up authentication required',
        challenge: '/api/auth/webauthn/challenge',
        stepUpRequired: true,
      })
    }

    next()
  }
}
