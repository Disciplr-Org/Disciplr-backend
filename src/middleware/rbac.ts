import { Request, Response, NextFunction } from 'express'
import { UserRole } from '@prisma/client'

export function requireRole(...allowedRoles: UserRole[]) {
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
export const requireUser = requireRole(UserRole.USER, UserRole.VERIFIER, UserRole.ADMIN)
export const requireVerifier = requireRole(UserRole.VERIFIER, UserRole.ADMIN)
export const requireAdmin = requireRole(UserRole.ADMIN)