import { Request, Response, NextFunction } from 'express'
import { verifyAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/domain.js'

export const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' })
    }

    const token = authHeader.split(' ')[1]

    try {
        const payload = verifyAccessToken(token)
        req.user = {
            userId: payload.userId,
            role: payload.role as UserRole,
        }
        next()
    } catch (error) {
        return res.status(401).json({ error: 'Unauthorized: Token expired or invalid' })
    }
}

export const authorize = (roles: UserRole[]) => {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Forbidden: Insufficient permissions' })
        }
        next()
    }
}
