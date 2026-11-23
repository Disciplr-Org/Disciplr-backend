import { getPrisma } from '../lib/prismaScope.js'
import { hashPassword, comparePassword, generateAccessToken, generateRefreshToken, verifyRefreshToken, hashToken } from '../lib/auth-utils.js'
import { RegisterInput, LoginInput } from '../lib/validation.js'
import { UserRole } from '../types/user.js'
import { randomUUID } from 'node:crypto'
import { recordSession, revokeAllUserSessions } from './session.js'
import { getStepUpStore } from './stepUpStore.js'

const STEP_UP_TTL_SECONDS = 5 * 60

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

    static async issueStepUpChallenge(userId: string) {
        const nonce = randomUUID()
        const expiresAt = new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000)
        await getStepUpStore().issue(nonce, userId, expiresAt)

        return {
            nonce,
            expiresAt: expiresAt.getTime(),
            ttlSeconds: STEP_UP_TTL_SECONDS,
            challenge: 'webauthn-step-up',
        }
    }

    static async recordStepUpAssertion(nonce: string, userId: string) {
        return (await getStepUpStore().consume(nonce, { userId })) !== null
    }

    static async validateStepUpSession(sessionId: string, maxAgeSeconds = STEP_UP_TTL_SECONDS) {
        const entry = await getStepUpStore().consume(sessionId, {
            maxRemainingAgeMs: maxAgeSeconds * 1000,
        })
        return entry ? { userId: entry.userId, sessionId } : null
    }

    static async registerWebAuthnCredential(userId: string, credentialId: string, publicKey: string) {
        await getPrisma().$executeRaw`
            INSERT INTO "webauthn_credentials" ("user_id", "credential_id", "public_key")
            VALUES (${userId}, ${credentialId}, ${publicKey})
            ON CONFLICT ("credential_id") DO UPDATE SET
                "public_key" = EXCLUDED."public_key",
                "updated_at" = CURRENT_TIMESTAMP,
                "last_used_at" = CURRENT_TIMESTAMP
        `

        return { userId, credentialId, publicKey }
    }
}

