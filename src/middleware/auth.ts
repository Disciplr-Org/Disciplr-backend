import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { recordSession, validateSession } from '../services/session.js'

import { JWTPayload } from '../types/auth.js'

export type Role = 'user' | 'verifier' | 'admin'

// Use JWTPayload from types/auth.ts as source of truth, adding jti for sessions
export type JwtPayload = JWTPayload & { jti?: string }

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
     const authHeader = req.headers.authorization

     if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or malformed Authorization header' })
          return
     }

     const token = authHeader.slice(7)

     try {
          const payload = jwt.verify(token, JWT_SECRET) as JwtPayload
          
          if (payload.jti) {
               const isValid = await validateSession(payload.jti)
               
               if (!isValid) {
                    res.status(401).json({ error: 'Session revoked or expired' })
                    return
               }
          }

          req.user = payload
          next()
     } catch (err) {
          if (err instanceof jwt.TokenExpiredError) {
               res.status(401).json({ error: 'Token expired' })
          } else {
               res.status(401).json({ error: 'Invalid token' })
          }
     }
}

export async function signToken(payload: Omit<JwtPayload, 'jti'>, expiresIn = '1h'): Promise<string> {
     const jti = randomUUID()
     const fullPayload = { ...payload, jti }
     
     // Calculate expiration date
     // Default matches 1h (1 hour)
     const durationMs = 60 * 60 * 1000 
     const expiresAt = new Date(Date.now() + durationMs)
     
     await recordSession(payload.userId, jti, expiresAt)
     
     return jwt.sign(fullPayload, JWT_SECRET, { expiresIn } as jwt.SignOptions)
}

export interface AuthenticatedRequest extends Request {
    user?: JwtPayload
}

export function requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): void {
    if (req.user?.role !== 'ADMIN') {
        res.status(403).json({ error: 'Admin role required' })
        return
    }
    next()
}

export function authorize(allowedRoles: string[]) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (!req.user) {
            res.status(401).json({ error: 'Authentication required' })
            return
        }
        if (!allowedRoles.includes(req.user.role)) {
            res.status(403).json({ error: 'Permission denied' })
            return
        }
        next()
    }
}

/** Generate a time-limited, HMAC-signed download token */
const DOWNLOAD_SECRET = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'

export function signDownloadToken(jobId: string, userId: string, ttlSeconds = 3600): string {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const payload = `${jobId}:${userId}:${exp}`
    const sig = crypto.createHmac('sha256', DOWNLOAD_SECRET).update(payload).digest('hex')
    return Buffer.from(JSON.stringify({ jobId, userId, exp, sig })).toString('base64url')
}

export function verifyDownloadToken(
    token: string,
): { jobId: string; userId: string } | null {
    try {
        const { jobId, userId, exp, sig } = JSON.parse(
            Buffer.from(token, 'base64url').toString(),
        ) as { jobId: string; userId: string; exp: number; sig: string }

        if (Date.now() / 1000 > exp) return null

        const expected = crypto
            .createHmac('sha256', DOWNLOAD_SECRET)
            .update(`${jobId}:${userId}:${exp}`)
            .digest('hex')

        if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null

        return { jobId, userId }
    } catch {
        return null
    }
}