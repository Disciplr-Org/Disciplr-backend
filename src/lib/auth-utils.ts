import jwt from 'jsonwebtoken'
import bcrypt from 'bcryptjs'
import { createHash, randomUUID } from 'node:crypto'

// --------------- Secrets & Constants ---------------

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret'
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'fallback-refresh-secret'

export const JWT_ISSUER = 'disciplr'
export const JWT_AUDIENCE = 'disciplr-api'

const MIN_SECRET_LENGTH = 32

/**
 * Validate that JWT secrets meet minimum length requirements.
 * Call this during application startup — it throws in production
 * if secrets are too short, and warns in development.
 */
export function validateJwtSecrets(): void {
    const isProduction = process.env.NODE_ENV === 'production'
    const problems: string[] = []

    if (ACCESS_SECRET.length < MIN_SECRET_LENGTH) {
        problems.push(
            `JWT_ACCESS_SECRET is ${ACCESS_SECRET.length} chars (minimum ${MIN_SECRET_LENGTH})`,
        )
    }
    if (REFRESH_SECRET.length < MIN_SECRET_LENGTH) {
        problems.push(
            `JWT_REFRESH_SECRET is ${REFRESH_SECRET.length} chars (minimum ${MIN_SECRET_LENGTH})`,
        )
    }

    if (problems.length > 0) {
        const msg = `JWT secret validation failed:\n  • ${problems.join('\n  • ')}`
        if (isProduction) {
            throw new Error(msg)
        } else {
            console.warn(`⚠️  ${msg}`)
        }
    }
}

// --------------- Password Hashing ---------------

export const hashPassword = async (password: string): Promise<string> => {
    return bcrypt.hash(password, 12)
}

export const comparePassword = async (password: string, hash: string): Promise<boolean> => {
    return bcrypt.compare(password, hash)
}

// --------------- Refresh Token Hashing ---------------

/**
 * Hash a refresh token using SHA-256.
 *
 * We use a fast hash (not bcrypt) because refresh tokens are high-entropy
 * random strings (128+ bits) that are not susceptible to dictionary attacks.
 * SHA-256 is deterministic, which lets us look up the hash in the DB.
 */
export const hashToken = (token: string): string => {
    return createHash('sha256').update(token).digest('hex')
}

// --------------- JWT Generation ---------------

export const generateAccessToken = (payload: { userId: string; role: string; jti?: string }): string => {
    const fullPayload: Record<string, unknown> = {
        sub: payload.userId,
        role: payload.role,
        // Keep userId for backward compatibility with existing middleware/routes
        userId: payload.userId,
    }

    if (payload.jti !== undefined) {
        fullPayload.jti = payload.jti
    }

    return jwt.sign(fullPayload, ACCESS_SECRET, {
        expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN || '15m') as any,
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    })
}

export const generateRefreshToken = (payload: { userId: string }): string => {
    return jwt.sign(payload, REFRESH_SECRET, {
        expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || '7d') as any,
    })
}

// --------------- JWT Verification ---------------

export const verifyAccessToken = (token: string) => {
    return jwt.verify(token, ACCESS_SECRET, {
        clockTolerance: 30, // 30 seconds tolerance for minor clock skew
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    }) as { userId: string; role: string; jti?: string; sub?: string }
}

export const verifyRefreshToken = (token: string) => {
    return jwt.verify(token, REFRESH_SECRET, {
        clockTolerance: 30,
    }) as { userId: string }
}
