import { getPrisma } from '../lib/prismaScope.js'
import { hashPassword, comparePassword, generateAccessToken, generateRefreshToken, verifyRefreshToken, hashToken } from '../lib/auth-utils.js'
import { RegisterInput, LoginInput } from '../lib/validation.js'
import { UserRole } from '../types/user.js'
import { randomUUID } from 'node:crypto'
import { recordSession, revokeAllUserSessions } from './session.js'

const STEP_UP_TTL_SECONDS = 5 * 60
const STEP_UP_NONCES = new Map<string, { userId: string; action?: string; expiresAt: number; used: boolean }>()

export class AuthService {
    static async register(input: RegisterInput) {
        try {
            const hashedPassword = await hashPassword(input.password)
            const user = await getPrisma().user.create({
                data: {
                    email: input.email,
                    passwordHash: hashedPassword,
                    role: input.role || UserRole.USER,
                },
            })

            return { id: user.id, email: user.email, role: user.role }
        } catch (error: any) {
            if (error.code === 'P2002') {
                throw new Error('Email already in use')
            }
            throw error
        }
    }

    static async login(input: LoginInput) {
        const prisma = getPrisma()
        const user = await prisma.user.findUnique({ where: { email: input.email } })
        if (!user) {
            throw new Error('Invalid credentials')
        }

        const isValid = await comparePassword(input.password, user.passwordHash)
        if (!isValid) {
            throw new Error('Invalid credentials')
        }

        const jti = randomUUID()
        const sessionId = randomUUID()
        const lastLoginAt = new Date()
        const accessToken = generateAccessToken({ userId: user.id, role: user.role, jti })
        const refreshTokenValue = generateRefreshToken({ userId: user.id })
        const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
        const tokenHash = hashToken(refreshTokenValue)

        const loggedInUser = await prisma.$transaction(async (tx) => {
            const updatedUser = await tx.user.update({
                where: { id: user.id },
                data: { lastLoginAt },
            })

            await tx.$executeRaw`
                INSERT INTO "sessions" ("id", "user_id", "jti", "expires_at")
                VALUES (${sessionId}, ${user.id}, ${jti}, ${accessExpiresAt})
            `

            await tx.refreshToken.create({
                data: {
                    token: tokenHash,
                    userId: user.id,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                },
            })

            return updatedUser
        })

        return {
            user: { id: loggedInUser.id, email: loggedInUser.email, role: loggedInUser.role },
            accessToken,
            refreshToken: refreshTokenValue,
        }
    }

    static async refresh(token: string) {
        try {
            const payload = verifyRefreshToken(token)

            // Look up by hash — we never store the raw token
            const tokenHash = hashToken(token)
            const storedToken = await getPrisma().refreshToken.findUnique({
                where: { token: tokenHash },
                include: { user: true },
            })

            if (!storedToken || storedToken.revokedAt || storedToken.expiresAt < new Date()) {
                throw new Error('Invalid or expired refresh token')
            }

            // Revoke old token BEFORE issuing new ones (no dual-valid window)
            await getPrisma().refreshToken.update({
                where: { id: storedToken.id },
                data: { revokedAt: new Date() },
            })

            const jti = randomUUID()
            const newAccessToken = generateAccessToken({ userId: storedToken.user.id, role: storedToken.user.role, jti })
            const newRefreshTokenValue = generateRefreshToken({ userId: storedToken.user.id })

            // 1. Record new session for access token
            const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
            await recordSession(storedToken.user.id, jti, accessExpiresAt)

            // 2. Store hashed new refresh token
            const newTokenHash = hashToken(newRefreshTokenValue)
            await getPrisma().refreshToken.create({
                data: {
                    token: newTokenHash,
                    userId: storedToken.user.id,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                },
            })

            return {
                accessToken: newAccessToken,
                refreshToken: newRefreshTokenValue,
            }
        } catch (error) {
            throw new Error('Invalid refresh token')
        }
    }

    static async logout(token: string) {
        const tokenHash = hashToken(token)
        await getPrisma().refreshToken.updateMany({
            where: { token: tokenHash },
            data: { revokedAt: new Date() },
        })
    }

    /**
     * Revoke ALL refresh tokens AND sessions for a user.
     * Used by the /logout-all endpoint.
     */
    static async logoutAll(userId: string) {
        // 1. Revoke all refresh tokens for this user
        await getPrisma().refreshToken.updateMany({
            where: { userId, revokedAt: null },
            data: { revokedAt: new Date() },
        })

        // 2. Revoke all access token sessions
        await revokeAllUserSessions(userId)
    }

    static async issueStepUpChallenge(userId: string, action?: string) {
        const nonce = randomUUID()
        const expiresAt = Date.now() + STEP_UP_TTL_SECONDS * 1000
        STEP_UP_NONCES.set(nonce, { userId, action, expiresAt, used: false })

        return {
            nonce,
            expiresAt,
            ttlSeconds: STEP_UP_TTL_SECONDS,
            challenge: 'webauthn-step-up',
        }
    }

    static async recordStepUpAssertion(nonce: string, userId: string) {
        const entry = STEP_UP_NONCES.get(nonce)
        if (!entry || entry.used || entry.expiresAt < Date.now() || entry.userId !== userId) {
            return false
        }

        entry.used = true
        STEP_UP_NONCES.delete(nonce)
        return true
    }

    static async validateStepUpSession(sessionId: string, maxAgeSeconds = STEP_UP_TTL_SECONDS, action?: string) {
        const entry = STEP_UP_NONCES.get(sessionId)
        if (!entry || entry.used || entry.expiresAt < Date.now()) {
            return null
        }

        const maxAgeMs = maxAgeSeconds * 1000
        const isFresh = entry.expiresAt - Date.now() <= maxAgeMs
        if (!isFresh) {
            return null
        }

        if (action && entry.action && entry.action !== action) {
            return null
        }

        entry.used = true
        STEP_UP_NONCES.delete(sessionId)
        return { userId: entry.userId, sessionId }
    }

    static async registerWebAuthnCredential(userId: string, credentialId: string, publicKey: string) {
        const existing = await getPrisma().$queryRaw<{ credential_id: string }[]>`
            SELECT "credential_id" FROM "webauthn_credentials"
            WHERE "credential_id" = ${credentialId}
            LIMIT 1
        `

        if (existing.length > 0) {
            throw new Error('Credential already registered')
        }

        await getPrisma().$executeRaw`
            INSERT INTO "webauthn_credentials" ("user_id", "credential_id", "public_key", "counter")
            VALUES (${userId}, ${credentialId}, ${publicKey}, 0)
        `

        return { userId, credentialId, publicKey }
    }

    static async verifyWebAuthnAssertion(credentialId: string, newCounter: number) {
        const rows = await getPrisma().$queryRaw<{ counter: number }[]>`
            SELECT "counter" FROM "webauthn_credentials"
            WHERE "credential_id" = ${credentialId}
            LIMIT 1
        `

        if (rows.length === 0) {
            throw new Error('Credential not found')
        }

        const storedCounter = rows[0].counter

        if (newCounter <= storedCounter) {
            throw new Error('Counter regression detected: possible cloned authenticator')
        }

        await getPrisma().$executeRaw`
            UPDATE "webauthn_credentials"
            SET "counter" = ${newCounter}, "last_used_at" = CURRENT_TIMESTAMP
            WHERE "credential_id" = ${credentialId}
        `

        return { credentialId, counter: newCounter }
    }
}

