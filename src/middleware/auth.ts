import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'

import { JWTPayload } from '../types/auth.js'

export type Role = 'user' | 'verifier' | 'admin'

// Use JWTPayload from types/auth.ts as source of truth
export type JwtPayload = JWTPayload

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

export function authenticate(req: Request, res: Response, next: NextFunction): void {
     const authHeader = req.headers.authorization

     if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Missing or malformed Authorization header' })
          return
     }

     const token = authHeader.slice(7)

     try {
          const payload = jwt.verify(token, JWT_SECRET) as JwtPayload
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

export function signToken(payload: JwtPayload, expiresIn = '1h'): string {
     return jwt.sign(payload, JWT_SECRET, { expiresIn } as jwt.SignOptions)

export function requireAdmin(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): void {
    if (req.user?.role !== 'admin') {
        res.status(403).json({ error: 'Admin role required' })
        return
    }
    next()
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