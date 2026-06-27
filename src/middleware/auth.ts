import { Request, Response, NextFunction } from 'express'
import crypto from 'crypto'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'
import { recordSession, validateSession } from '../services/session.js'
import { UserRole } from '../types/user.js'

import { JWTPayload } from '../types/auth.js'

export type Role = 'user' | 'verifier' | 'admin'

// Use JWTPayload from types/auth.ts as source of truth, adding jti for sessions
export type JwtPayload = JWTPayload & { jti?: string }

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])
const CSRF_COOKIE_NAME = 'csrf_token'
const CSRF_HEADER_NAME = 'x-csrf-token'

function parseCookieHeader(cookieHeader: string | undefined): Map<string, string> {
    const cookies = new Map<string, string>()
    if (!cookieHeader) return cookies

    for (const part of cookieHeader.split(';')) {
        const separatorIndex = part.indexOf('=')
        if (separatorIndex === -1) continue
        const name = part.slice(0, separatorIndex).trim()
        const value = part.slice(separatorIndex + 1).trim()
        if (name) cookies.set(name, value)
    }

    return cookies
}

function timingSafeStringEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left)
    const rightBuffer = Buffer.from(right)
    const maxLength = Math.max(leftBuffer.length, rightBuffer.length, 1)
    const paddedLeft = Buffer.alloc(maxLength)
    const paddedRight = Buffer.alloc(maxLength)

    leftBuffer.copy(paddedLeft)
    rightBuffer.copy(paddedRight)

    return crypto.timingSafeEqual(paddedLeft, paddedRight) && leftBuffer.length === rightBuffer.length
}

function hasBearerAuth(req: Request): boolean {
    return req.header('authorization')?.startsWith('Bearer ') ?? false
}

function hasApiKeyAuth(req: Request): boolean {
    return Boolean(req.header('x-api-key'))
}

function normalizeOrigin(value: string | undefined): string | null {
    if (!value) return null
    try {
        const url = new URL(value)
        return `${url.protocol}//${url.host}`.toLowerCase()
    } catch {
        return null
    }
}

function getRequestOrigin(req: Request): string | null {
    const forwardedHost = req.header('x-forwarded-host')?.split(',')[0]?.trim()
    const host = forwardedHost || req.header('host')
    if (!host) return null

    const forwardedProto = req.header('x-forwarded-proto')?.split(',')[0]?.trim()
    const protocol = forwardedProto || req.protocol || (req.secure ? 'https' : 'http')
    return `${protocol}://${host}`.toLowerCase()
}

function isSameOrigin(req: Request): boolean {
    const suppliedOrigin = normalizeOrigin(req.header('origin') || req.header('referer'))
    const requestOrigin = getRequestOrigin(req)
    return Boolean(suppliedOrigin && requestOrigin && suppliedOrigin === requestOrigin)
}

function hasValidDoubleSubmitToken(req: Request): boolean {
    const cookies = parseCookieHeader(req.header('cookie'))
    const cookieToken = cookies.get(CSRF_COOKIE_NAME)
    const headerToken = req.header(CSRF_HEADER_NAME)

    return Boolean(cookieToken && headerToken && timingSafeStringEqual(cookieToken, headerToken))
}

export function csrfProtection(req: Request, res: Response, next: NextFunction): void {
    if (!MUTATING_METHODS.has(req.method.toUpperCase())) {
        next()
        return
    }

    if (hasBearerAuth(req) || hasApiKeyAuth(req)) {
        next()
        return
    }

    if (!req.header('cookie')) {
        next()
        return
    }

    if (hasValidDoubleSubmitToken(req) || isSameOrigin(req)) {
        next()
        return
    }

    res.status(403).json({ error: 'CSRF validation failed.' })
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
     const authHeader = req.headers.authorization

     if (!authHeader || !authHeader.startsWith('Bearer ')) {
          res.status(401).json({ error: 'Unauthorized: Missing or malformed Authorization header' })
          return
     }

     const token = authHeader.slice(7)

     try {
          const payload = jwt.verify(token, JWT_SECRET) as JwtPayload

          // Reject tokens with iat too far in the future (beyond clock tolerance)
          const iat = (payload as any).iat as number | undefined
          if (iat && iat > Math.floor(Date.now() / 1000) + 30) {
               res.status(401).json({ error: 'Unauthorized: Invalid token' })
               return
          }

          if (payload.jti) {
               const isValid = await validateSession(payload.jti)

               if (!isValid) {
                    res.status(401).json({ error: 'Unauthorized: Session revoked or expired' })
                    return
               }
          }

          req.user = payload
          next()
     } catch (err) {
          if (err instanceof jwt.TokenExpiredError) {
               res.status(401).json({ error: 'Unauthorized: Token expired' })
          } else {
               res.status(401).json({ error: 'Unauthorized: Invalid token' })
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
    if (!req.user) {
        res.status(401).json({ error: 'Unauthorized: Authentication required' })
        return
    }
    if (req.user.role !== 'ADMIN') {
        res.status(403).json({ error: 'Forbidden: Admin role required' })
        return
    }
    next()
}

export function authorize(allowedRoles: UserRole[]) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
        if (!req.user) {
            res.status(401).json({ error: 'Unauthenticated' })
            return
        }

        if (!allowedRoles.includes(req.user.role as UserRole)) {
            res.status(403).json({
                error: `Forbidden: requires role ${allowedRoles.join(' or ')}, got '${req.user.role}'`,
            })
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
/**
 * @deprecated Use standard `authenticate` instead. Legacy mock auth for early dev. Tracking removal in #454
 */
export const requireUserAuth = (req: Request, res: Response, next: NextFunction): void => {
    const headerUserId = req.header('x-user-id')?.trim()
    let bearerUserId = null
    const authHeader = req.header('authorization')
    if (authHeader) {
        const match = /^Bearer\s+(.+)$/i.exec(authHeader)
        if (match) {
            const token = match[1].trim()
            bearerUserId = token.startsWith('user:') ? token.slice(5) : token
        }
    }
    const userId = headerUserId || bearerUserId
    
    if (!userId) {
        res.status(401).json({
            error: 'Authentication required. Provide x-user-id header or Authorization: Bearer user:<user-id>.',
        })
        return
    }
    
    // @ts-ignore - Preserving legacy property assignment
    req.authUser = { userId }
    next()
}
