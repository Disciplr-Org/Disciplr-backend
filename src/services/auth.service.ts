import { getEnv } from '../config/env.js'
import { getPrisma } from '../lib/prismaScope.js'
import { hashPassword, comparePassword, generateAccessToken, generateRefreshToken, verifyRefreshToken, hashToken } from '../lib/auth-utils.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { RegisterInput, LoginInput } from '../lib/validation.js'
import { UserRole } from '../types/user.js'
import {
  randomUUID,
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from 'node:crypto'
import { AppError } from '../middleware/errorHandler.js'
import { recordSession, revokeAllUserSessions } from './session.js'
import { getStepUpStore } from './stepUpStore.js'

const STEP_UP_TTL_SECONDS = 5 * 60

export interface VerifyStepUpAssertionInput {
  nonce: string
  userId: string
  credentialId: string
  clientDataJSON: string
  authenticatorData: string
  signature: string
  /** Expected browser origin. Defaults to WebAuthn/CORS configuration. */
  origin?: string
}

export interface VerifyStepUpAssertionResult {
  stepUpSessionId: string | null
  reason?: string
}

interface CborCursor {
  offset: number
}

/**
 * Minimal CBOR decoder for COSE_Key values emitted by WebAuthn authenticators.
 * Only the integer/byte-string/map forms used by EC2 keys are needed here.
 */
function decodeCbor(buf: Buffer, cursor: CborCursor): unknown {
  if (cursor.offset >= buf.length) throw new Error('Malformed CBOR')
  const initial = buf[cursor.offset++]
  const major = initial >> 5
  const additional = initial & 0x1f

  const readBytes = (count: number): number => {
    if (count <= 0 || cursor.offset + count > buf.length) throw new Error('Malformed CBOR')
    let value = 0
    for (let i = 0; i < count; i += 1) {
      value = value * 256 + buf[cursor.offset++]
    }
    return value
  }

  const argument = (): number => {
    if (additional < 24) return additional
    if (additional === 24) return readBytes(1)
    if (additional === 25) return readBytes(2)
    if (additional === 26) return readBytes(4)
    throw new Error('Unsupported CBOR encoding')
  }

  switch (major) {
    case 0:
      return argument()
    case 1:
      return -1 - argument()
    case 2: {
      const length = argument()
      if (cursor.offset + length > buf.length) throw new Error('Malformed CBOR')
      const value = buf.subarray(cursor.offset, cursor.offset + length)
      cursor.offset += length
      return Buffer.from(value)
    }
    case 3: {
      const length = argument()
      if (cursor.offset + length > buf.length) throw new Error('Malformed CBOR')
      const value = buf.subarray(cursor.offset, cursor.offset + length).toString('utf8')
      cursor.offset += length
      return value
    }
    case 4: {
      const length = argument()
      const values: unknown[] = []
      for (let i = 0; i < length; i += 1) values.push(decodeCbor(buf, cursor))
      return values
    }
    case 5: {
      const length = argument()
      const entries = new Map<unknown, unknown>()
      for (let i = 0; i < length; i += 1) {
        const key = decodeCbor(buf, cursor)
        entries.set(key, decodeCbor(buf, cursor))
      }
      return entries
    }
    default:
      throw new Error('Unsupported CBOR type')
  }
}

/** Parse the credential public key from storage (PEM, DER SPKI, or COSE_Key). */
function storedCredentialPublicKey(publicKey: string): KeyObject {
  const stored = publicKey.trim()
  if (!stored) throw new Error('Stored credential has no public key')

  if (stored.startsWith('-----BEGIN')) {
    return createPublicKey(stored)
  }

  const bytes = Buffer.from(stored, 'base64url')
  try {
    return createPublicKey({ key: bytes, format: 'der', type: 'spki' })
  } catch {
    // Not DER SPKI — fall through to the COSE_Key representation.
  }

  const cose = decodeCbor(bytes, { offset: 0 })
  if (!(cose instanceof Map)) throw new Error('Unsupported stored credential public key')

  const kty = cose.get(1)
  const alg = cose.get(3)
  const crv = cose.get(-1)
  const x = cose.get(-2)
  const y = cose.get(-3)

  if (kty !== 2 || crv !== 1 || !Buffer.isBuffer(x) || !Buffer.isBuffer(y)) {
    throw new Error('Unsupported stored credential public key')
  }
  if (alg !== undefined && alg !== -7) {
    throw new Error('Unsupported WebAuthn signature algorithm')
  }

  return createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: x.toString('base64url'),
      y: y.toString('base64url'),
    },
    format: 'jwk',
  })
}

const normalizeOrigin = (origin: string): string => origin.trim().replace(/\/+$/, '')

/** Resolve the exact browser origin allowed in WebAuthn clientDataJSON. */
export function getWebAuthnOrigin(): string {
  try {
    const env = getEnv()
    if (env.WEBAUTHN_ORIGIN) return normalizeOrigin(env.WEBAUTHN_ORIGIN)
    if (env.CORS_ORIGINS && env.CORS_ORIGINS !== '*') {
      return normalizeOrigin(env.CORS_ORIGINS.split(',')[0].trim())
    }
  } catch {
    // Env may not be initialised in unit tests; fall back to process.env.
  }

  const configured = process.env.WEBAUTHN_ORIGIN ?? process.env.CORS_ORIGINS?.split(',')[0]?.trim()
  if (!configured || configured === '*') throw new Error('WebAuthn origin is not configured')
  return normalizeOrigin(configured)
}

/** Resolve the relying-party id whose SHA-256 hash is embedded in authenticatorData. */
export function getWebAuthnRpId(origin = getWebAuthnOrigin()): string {
  try {
    const env = getEnv()
    if (env.WEBAUTHN_RP_ID) return env.WEBAUTHN_RP_ID
  } catch {
    // Env may not be initialised in unit tests; fall back to process.env.
  }
  if (process.env.WEBAUTHN_RP_ID) return process.env.WEBAUTHN_RP_ID
  return new URL(origin).hostname
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

    private static async revokeRefreshTokenFamily(userId: string, token: string, familyId?: string | null, tx?: any) {
        const tokenHash = hashToken(token)
        const client = tx ?? getPrisma()
        const now = new Date()

        if (familyId) {
            await client.refreshToken.updateMany({
                where: { familyId, revokedAt: null },
                data: { revokedAt: now },
            })
        } else {
            await client.refreshToken.updateMany({
                where: { token: tokenHash, revokedAt: null },
                data: { revokedAt: now },
            })
        }

        await this.emitSecurityAudit('auth.refresh_token_reuse_detected', 'refresh_token', userId, {
            reason: 'refresh_token_reuse',
            tokenFingerprint: tokenHash.slice(0, 12),
            ...(familyId ? { familyId } : {}),
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
        
        // Timing equalisation: run bcrypt even if user not found, using a dummy hash.
        // This prevents timing attacks that reveal whether an email exists in the system.
        const hashToCheck = user?.passwordHash ?? DUMMY_PASSWORD_HASH
        const isValid = await comparePassword(input.password, hashToCheck)
        
        if (!user) {
            // Audit the failed login attempt
            await this.emitSecurityAudit('auth.login_failed', 'user', input.email, {
                reason: 'user_not_found',
                email: input.email,
            })
            throw new Error('Invalid credentials')
        }

        // Soft-deleted or non-active accounts are never allowed to authenticate,
        // regardless of password correctness — fail closed.
        const isActive = typeof user.status !== 'string' || user.status === 'ACTIVE'
        if (user.deletedAt || !isActive) {
            await this.emitSecurityAudit('auth.login_failed', 'user', user.id, {
                reason: 'account_inactive',
                email: input.email,
            }, user.id)
            throw new Error('Invalid credentials')
        }

        if (!isValid) {
            await this.emitSecurityAudit('auth.login_failed', 'user', user.id, {
                reason: 'wrong_password',
                email: input.email,
            }, user.id)
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

            const familyId = randomUUID()
            await tx.refreshToken.create({
                data: {
                    token: tokenHash,
                    userId: user.id,
                    familyId,
                    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
                },
            })

            return updatedUser
        })

        // Audit successful login
        await this.emitSecurityAudit('auth.login_success', 'user', user.id, {
            email: input.email,
        }, user.id)

        return {
            user: { id: loggedInUser.id, email: loggedInUser.email, role: loggedInUser.role },
            accessToken,
            refreshToken: refreshTokenValue,
        }
    }

    static async refresh(token: string) {
        let payload: any
        try {
            payload = verifyRefreshToken(token, getEnv())
        } catch {
            throw new AppError(401, 'UNAUTHORIZED' as any, 'Invalid refresh token')
        }

        const tokenHash = hashToken(token)
        const prisma = getPrisma()

        try {
            return await prisma.$transaction(async (tx: any) => {
                const now = new Date()

                // Atomic compare-and-set: revoke the token only if it is currently valid and unrevoked
                const updateResult = await tx.refreshToken.updateMany({
                    where: {
                        token: tokenHash,
                        revokedAt: null,
                        expiresAt: { gt: now },
                    },
                    data: {
                        revokedAt: now,
                    },
                })

                if (updateResult.count === 0) {
                    // Lost race, already used, or expired.
                    const existingToken = await prisma.refreshToken.findUnique({
                        where: { token: tokenHash },
                        include: { user: true },
                    })

                    if (existingToken) {
                        // Lost race, reuse, or expired: revoke this family plus emit security audit
                        await this.revokeRefreshTokenFamily(
                            existingToken.userId,
                            token,
                            existingToken.familyId,
                        )
                    }

                    throw new AppError(401, 'UNAUTHORIZED' as any, 'Invalid refresh token')
                }

                // CAS succeeded! Fetch the rotated token details
                const storedToken = await tx.refreshToken.findUnique({
                    where: { token: tokenHash },
                    include: { user: true },
                })

                if (!storedToken || !storedToken.user) {
                    throw new AppError(401, 'UNAUTHORIZED' as any, 'Invalid refresh token')
                }

                const familyId = storedToken.familyId ?? randomUUID()
                const jti = randomUUID()
                const env = getEnv()
                const newAccessToken = generateAccessToken(
                    { userId: storedToken.user.id, role: storedToken.user.role, jti },
                    env,
                )
                const newRefreshTokenValue = generateRefreshToken({ userId: storedToken.user.id, jti: randomUUID() }, env)
                const newTokenHash = hashToken(newRefreshTokenValue)

                // 1. Record session for new access token
                const accessExpiresAt = new Date(Date.now() + 15 * 60 * 1000)
                await recordSession(storedToken.user.id, jti, accessExpiresAt)

                // 2. Create the successor refresh token in the same family
                const newToken = await tx.refreshToken.create({
                    data: {
                        token: newTokenHash,
                        userId: storedToken.user.id,
                        familyId,
                        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                    },
                })

                // 3. Link rotated token to successor via replacedById
                await tx.refreshToken.update({
                    where: { id: storedToken.id },
                    data: { replacedById: newToken.id },
                })

                return {
                    accessToken: newAccessToken,
                    refreshToken: newRefreshTokenValue,
                }
            })
        } catch (error) {
            if (error instanceof AppError) {
                throw error
            }
            // Infrastructure or database failure rethrown as 503 Service Unavailable
            throw new AppError(503, 'INTERNAL_ERROR' as any, 'Database operation failed')
        }
    }

    static async logout(token: string) {
        const tokenHash = hashToken(token)
        const prisma = getPrisma()
        const existingToken = await prisma.refreshToken.findUnique({
            where: { token: tokenHash },
        })

        const now = new Date()
        if (existingToken?.familyId) {
            // Revoke the token's whole family
            await prisma.refreshToken.updateMany({
                where: { familyId: existingToken.familyId, revokedAt: null },
                data: { revokedAt: now },
            })
        } else {
            await prisma.refreshToken.updateMany({
                where: { token: tokenHash, revokedAt: null },
                data: { revokedAt: now },
            })
        }
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
        const expiresAt = new Date(Date.now() + STEP_UP_TTL_SECONDS * 1000)
        await getStepUpStore().issue(nonce, userId, expiresAt, {
            kind: 'challenge',
            ...(action !== undefined ? { action } : {}),
        })

        return {
            nonce,
            expiresAt: expiresAt.getTime(),
            ttlSeconds: STEP_UP_TTL_SECONDS,
            challenge: 'webauthn-step-up',
            ...(action !== undefined ? { action } : {}),
        }
    }

    /**
     * Create a verified step-up session. Only `verifyStepUpAssertion` should
     * call this in production; it is public so binding tests can exercise
     * session behaviour without a hardware authenticator.
     */
    static async createStepUpSession(userId: string, action?: string, ttlSeconds = STEP_UP_TTL_SECONDS) {
        const sessionId = randomUUID()
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
        await getStepUpStore().issue(sessionId, userId, expiresAt, {
            kind: 'session',
            ...(action !== undefined ? { action } : {}),
        })

        return { sessionId, expiresAt: expiresAt.getTime(), ttlSeconds }
    }

    /** Consume a challenge nonce. Kept for backwards-compatible callers/tests. */
    static async recordStepUpAssertion(nonce: string, userId: string) {
        return (await getStepUpStore().consume(nonce, { userId })) !== null
    }

    /**
     * Consume a verified step-up session. A single extra argument may be
     * either an expected user id or an expected action (legacy middleware
     * calls pass the action here); when both are supplied they are treated as
     * userId then action.
     */
    static async validateStepUpSession(
        sessionId: string,
        maxAgeSeconds = STEP_UP_TTL_SECONDS,
        expectedUserIdOrAction?: string,
        expectedAction?: string,
    ) {
        const entry = await getStepUpStore().consume(sessionId, {
            kind: 'session',
            maxRemainingAgeMs: maxAgeSeconds * 1000,
        })
        if (!entry) return null

        if (expectedUserIdOrAction !== undefined) {
            if (expectedAction !== undefined) {
                if (entry.userId !== expectedUserIdOrAction || entry.action !== expectedAction) {
                    return null
                }
            } else if (entry.userId !== expectedUserIdOrAction && entry.action !== expectedUserIdOrAction) {
                return null
            }
        }

        return { userId: entry.userId, sessionId }
    }

    /**
     * Verify a WebAuthn assertion against the credential stored for the user
     * and exchange it for a single-use, action-bound step-up session.
     *
     * The credential public key is always read from storage; request-supplied
     * key material is neither trusted nor accepted.
     */
    static async verifyStepUpAssertion(
        input: VerifyStepUpAssertionInput,
    ): Promise<VerifyStepUpAssertionResult> {
        const reject = (reason: string): VerifyStepUpAssertionResult => ({
            stepUpSessionId: null,
            reason,
        })

        try {
            if (!input.nonce || !input.userId || !input.credentialId) {
                return reject('Missing assertion fields')
            }

            // Consume the challenge first so a failed assertion cannot be
            // replayed with a different signature or origin.
            const challenge = await getStepUpStore().consume(input.nonce, {
                userId: input.userId,
                kind: 'challenge',
            })
            if (!challenge) return reject('Invalid or expired challenge')

            const expectedOrigin = input.origin ?? getWebAuthnOrigin()
            const rpId = getWebAuthnRpId(expectedOrigin)

            const clientDataBytes = Buffer.from(input.clientDataJSON ?? '', 'base64url')
            let clientData: { type?: unknown; challenge?: unknown; origin?: unknown; crossOrigin?: unknown }
            try {
                clientData = JSON.parse(clientDataBytes.toString('utf8'))
            } catch {
                return reject('Malformed clientDataJSON')
            }

            if (clientData.type !== 'webauthn.get') return reject('Unexpected clientData type')
            const expectedChallenge = Buffer.from(challenge.nonce, 'utf8').toString('base64url')
            if (clientData.challenge !== expectedChallenge) return reject('Challenge mismatch')
            if (clientData.origin !== expectedOrigin) return reject('Origin mismatch')
            if (clientData.crossOrigin === true) return reject('Cross-origin assertion rejected')

            const authenticatorData = Buffer.from(input.authenticatorData ?? '', 'base64url')
            if (authenticatorData.length < 37) return reject('Malformed authenticator data')
            const expectedRpIdHash = createHash('sha256').update(rpId).digest()
            if (!authenticatorData.subarray(0, 32).equals(expectedRpIdHash)) {
                return reject('RP ID hash mismatch')
            }

            const flags = authenticatorData[32]
            // UP (user presence) and UV (user verification) are both required
            // for step-up; backup bits are intentionally allowed.
            if ((flags & 0x05) !== 0x05) return reject('User presence/verification flags not set')

            const counter = authenticatorData.readUInt32BE(33)

            const rows = await getPrisma().$queryRaw<{ user_id: string; public_key: string }[]>`
                SELECT "user_id", "public_key" FROM "webauthn_credentials"
                WHERE "credential_id" = ${input.credentialId}
                LIMIT 1
            `
            const credential = rows[0]
            if (!credential || credential.user_id !== input.userId) {
                return reject('Credential not registered for this user')
            }

            const publicKey = storedCredentialPublicKey(credential.public_key)
            const clientDataHash = createHash('sha256').update(clientDataBytes).digest()
            const signedData = Buffer.concat([authenticatorData, clientDataHash])
            const signature = Buffer.from(input.signature ?? '', 'base64url')
            if (!verifySignature('sha256', signedData, publicKey, signature)) {
                return reject('Invalid signature')
            }

            // Atomic compare-and-set inside verifyWebAuthnAssertion rejects
            // equal/regressed counters and concurrent replays.
            await this.verifyWebAuthnAssertion(input.credentialId, counter)

            const session = await this.createStepUpSession(input.userId, challenge.action)
            return { stepUpSessionId: session.sessionId }
        } catch {
            return reject('Assertion verification failed')
        }
    }

    static async registerWebAuthnCredential(userId: string, credentialId: string, publicKey: string) {
        // The unique credential_id index is the synchronization point. An
        // existence check followed by INSERT races under concurrent requests.
        const inserted = await getPrisma().$executeRaw`
            INSERT INTO "webauthn_credentials" ("user_id", "credential_id", "public_key", "counter")
            VALUES (${userId}, ${credentialId}, ${publicKey}, 0)
            ON CONFLICT ("credential_id") DO NOTHING
        `

        if (inserted === 0) throw new Error('Credential already registered')

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

        const updated = await getPrisma().$executeRaw`
            UPDATE "webauthn_credentials"
            SET "counter" = ${newCounter}, "last_used_at" = CURRENT_TIMESTAMP
            WHERE "credential_id" = ${credentialId} AND "counter" < ${newCounter}
        `

        if (updated === 0) {
            throw new Error('Counter regression detected: possible cloned authenticator')
        }

        return { credentialId, counter: newCounter }
    }
}
