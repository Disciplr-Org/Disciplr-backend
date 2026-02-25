import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string
        role: 'user' | 'admin'
        email: string
    }
}

/**
 * Minimal JWT-like token verification stub.
 * Replace with a real JWT library (e.g. jsonwebtoken) in production.
 *
 * Expected header:  Authorization: Bearer <token>
 * Token format (base64url):  { userId, role, email, exp }
 */
export function authenticate(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
): void {
    const authHeader = req.headers.authorization
    if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' })
        return
    }

    const token = authHeader.slice(7)
    try {
        // --- stub decode (replace with jwt.verify in production) ---
        const payload = JSON.parse(
            Buffer.from(token.split('.')[1] ?? token, 'base64url').toString(),
        ) as { userId: string; role: string; email: string; exp: number }

        if (payload.exp && Date.now() / 1000 > payload.exp) {
            res.status(401).json({ error: 'Token expired' })
            return
        }

        req.user = {
            id: payload.userId,
            role: payload.role === 'admin' ? 'admin' : 'user',
            email: payload.email,
        }
        next()
    } catch {
        res.status(401).json({ error: 'Invalid token' })
    }
}

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