import { Response, NextFunction } from 'express'
import { AuthenticatedRequest } from './auth.js'

/**
 * Middleware that enforces enterprise eligibility.
 * Rejects requests if the auth context does not have isEnterprise: true.
 */
export function enterpriseGuard(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void {
  // 1. Ensure authentication (redundant but safe if used out of order)
  if (!req.user) {
    res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' })
    return
  }

  // 2. Check enterprise eligibility from auth context
  if (!req.user.isEnterprise) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'security.enterprise_denied',
        userId: req.user.userId,
        path: req.originalUrl,
        timestamp: new Date().toISOString(),
        reason: 'non_enterprise_user'
      })
    )

    res.status(403).json({
      error: 'Forbidden',
      message: 'This endpoint is restricted to enterprise accounts.'
    })
    return
  }

  // 3. Ensure enterprise identifier is present
  if (!req.user.enterpriseId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Enterprise configuration missing in auth context.'
    })
    return
  }

  next()
}
