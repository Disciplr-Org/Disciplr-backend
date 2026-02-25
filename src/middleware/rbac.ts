import { Request, Response, NextFunction } from 'express'
import { Role } from './auth.js'

export function requireRole(...allowedRoles: Role[]) {
     return (req: Request, res: Response, next: NextFunction): void => {
          if (!req.user) {
               res.status(401).json({ error: 'Unauthenticated' })
               return
          }

          if (!allowedRoles.includes(req.user.role)) {
               res.status(403).json({
                    error: `Forbidden: requires role ${allowedRoles.join(' or ')}, got '${req.user.role}'`,
               })
               return
          }

          next()
     }
}

// Convenience helpers
export const requireUser = requireRole('user', 'verifier', 'admin')
export const requireVerifier = requireRole('verifier', 'admin')
export const requireAdmin = requireRole('admin')