import { getEnv } from '../config/env.js'
import { getPrisma } from '../lib/prismaScope.js'
import { hashPassword, comparePassword, generateAccessToken, generateRefreshToken, verifyRefreshToken, hashToken } from '../lib/auth-utils.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { RegisterInput, LoginInput } from '../lib/validation.js'
import { UserRole } from '../types/user.js'
import { randomUUID } from 'node:crypto'
import { recordSession, revokeAllUserSessions } from './session.js'

const STEP_UP_TTL_SECONDS = 5 * 60
const STEP_UP_NONCES = new Map<string, { userId: string; action?: string; expiresAt: number; used: boolean }>()
const BREACHED_PASSWORDS_ENV = 'AUTH_BREACHED_PASSWORDS'
const BREACHED_PASSWORDS_ENABLED_ENV = 'AUTH_BREACHED_PASSWORDS_ENABLED'

const parseBooleanEnv = (value?: string): boolean => {
    if (!value) return false
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
}

const getBreachedPasswordSet = (): Set<string> => {
    const rawValue = process.env[BREACHED_PASSWORDS_ENV] ?? ''
    return new Set(rawValue.split(',').map((entry) => entry.trim().toLowerCase()).filter(Boolean))
}

const isBreachedPasswordCheckEnabled = (): boolean => {
    if (parseBooleanEnv(process.env[BREACHED_PASSWORDS_ENABLED_ENV])) return true
    if (process.env[BREACHED_PASSWORDS_ENABLED_ENV] === undefined) {
        return Boolean(process.env[BREACHED_PASSWORDS_ENV])
    }
    return false
}

export class AuthService {
    private static async emitSecurityAudit(action: string, targetType: string, targetId: string, metadata: Record<string, unknown>, actorUserId = 'system') {
        try {
            await createAuditLog({
                actor_user_id: actorUserId,
                action,
                target_type: targetType,
                target_id: targetId,
                metadata,
            })
        } catch {
            // Security audit failures should never block the authentication flow.
        }
    }

    private static async ensurePasswordIsAllowed(password: string, context: { userId?: string; email?: string }) {
        if (!isBreachedPasswordCheckEnabled()) {
            return
        }

        const normalizedPassword = password.trim().toLowerCase()
        if (!normalizedPassword) {
            return
        }

        const breachedPasswords = getBreachedPasswordSet()
        if (!breachedPasswords.has(normalizedPassword)) {
            return
        }

        const actorUserId = context.userId ?? 'system'
        const targetId = context.userId ?? context.email ?? 'unknown'
        await this.emitSecurityAudit('auth.password_rejected', 'user', targetId, {
            reason: 'breached_password',
            email: context.email,
        }, actorUserId)

        throw new Error('Password rejected')
    }

    private static async revokeRefreshTokenFamily(userId: string, token: string) {
        const tokenHash = hashToken(token)
        const now = new Date()
        await getPrisma().refreshToken.updateMany({
            where: { userId },
            data: { revokedAt: now },
        })
        await revokeAllUserSessions(userId)
        await this.emitSecurityAudit('auth.refresh_token_reuse_detected', 'refresh_token', userId, {
            reason: 'refresh_token_reuse',
            tokenFingerprint: tokenHash.slice(0, 12),
        }, userId)
    }

    static async register(input: RegisterInput) {
        try {
            await this.ensurePasswordIsAllowed(input.password, { email: input.email })
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

    static async changePassword(userId: string, newPassword: string) {
        const prisma = getPrisma()
        const user = await prisma.user.findUnique({ where: { id: userId } })
        if (!user) {
            throw new Error('User not found')
        }

        await this.ensurePasswordIsAllowed(newPassword, { userId, email: user.email })
        const hashedPassword = await hashPassword(newPassword)
        const updatedUser = await prisma.user.update({
            where: { id: userId },
            data: { passwordHash: hashedPassword },
        })

        return { id: updatedUser.id, email: updatedUser.email, role: updatedUser.role }
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
        const env = getEnv()
        const accessToken = generateAccessToken({ userId: user.id, role: user.role, jti }, env)
        const refreshTokenValue = generateRefreshToken({ userId: user.id }, env)
        const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
        const tokenHash = hashToken(refreshTokenValue)

        const loggedInUser = await prisma.$transaction(async (tx: any) => {
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
            const payload = verifyRefreshToken(token, getEnv())

            // Look up by hash — we never store the raw token
            const tokenHash = hashToken(token)
            const storedToken = await getPrisma().refreshToken.findUnique({
                where: { token: tokenHash },
                include: { user: true },
            })

            if (!storedToken) {
                throw new Error('Invalid or expired refresh token')
            }

            if (storedToken.revokedAt || storedToken.expiresAt < new Date()) {
                await this.revokeRefreshTokenFamily(storedToken.user.id, token)
                throw new Error('Invalid refresh token')
            }

            // Revoke old token BEFORE issuing new ones (no dual-valid window)
            await getPrisma().refreshToken.update({
                where: { id: storedToken.id },
                data: { revokedAt: new Date() },
            })

            const jti = randomUUID()
            const env = getEnv()
            const newAccessToken = generateAccessToken({ userId: storedToken.user.id, role: storedToken.user.role, jti }, env)
            const newRefreshTokenValue = generateRefreshToken({ userId: storedToken.user.id }, env)

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
