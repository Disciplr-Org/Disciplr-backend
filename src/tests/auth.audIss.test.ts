import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import jwt from 'jsonwebtoken'
import {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from '../lib/auth-utils.js'
import { validateEnv } from '../config/env.js'

const ACCESS_SECRET = 'access-secret-for-aud-iss-tests-123'
const REFRESH_SECRET = 'refresh-secret-for-aud-iss-tests-123'

const managedEnvKeys = [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_SECRET',
  'JWT_KEYS',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'JWT_ACCESS_EXPIRES_IN',
  'JWT_REFRESH_EXPIRES_IN',
] as const

const originalEnv = new Map<string, string | undefined>()

function restoreManagedEnv() {
  for (const key of managedEnvKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function signAccessToken(
  claims: Record<string, unknown>,
  secret = ACCESS_SECRET,
  options: jwt.SignOptions = {},
) {
  return jwt.sign(claims, secret, {
    expiresIn: '15m',
    ...options,
  })
}

describe('JWT audience and issuer validation', () => {
  beforeEach(() => {
    for (const key of managedEnvKeys) {
      originalEnv.set(key, process.env[key])
      delete process.env[key]
    }

    process.env.JWT_ACCESS_SECRET = ACCESS_SECRET
    process.env.JWT_REFRESH_SECRET = REFRESH_SECRET
    process.env.JWT_ISSUER = 'disciplr'
    process.env.JWT_AUDIENCE = 'disciplr-api'
  })

  afterEach(() => {
    restoreManagedEnv()
    originalEnv.clear()
  })

  it('accepts a valid access token with configured aud/iss claims', () => {
    const token = generateAccessToken({
      userId: 'user-1',
      role: 'ADMIN',
      jti: 'jwt-id-1',
    })

    const decoded = jwt.decode(token) as jwt.JwtPayload
    expect(decoded.iss).toBe('disciplr')
    expect(decoded.aud).toBe('disciplr-api')

    const verified = verifyAccessToken(token)
    expect(verified.userId).toBe('user-1')
    expect(verified.role).toBe('ADMIN')
    expect(verified.jti).toBe('jwt-id-1')
  })

  it('rejects access tokens with missing or mismatched audience and issuer', () => {
    const baseClaims = { sub: 'user-1', userId: 'user-1', role: 'USER' }

    const missingClaims = signAccessToken(baseClaims)
    const wrongAudience = signAccessToken(baseClaims, ACCESS_SECRET, {
      issuer: 'disciplr',
      audience: 'other-api',
    })
    const wrongIssuer = signAccessToken(baseClaims, ACCESS_SECRET, {
      issuer: 'other-service',
      audience: 'disciplr-api',
    })

    expect(() => verifyAccessToken(missingClaims)).toThrow(/issuer|audience/i)
    expect(() => verifyAccessToken(wrongAudience)).toThrow(/audience/i)
    expect(() => verifyAccessToken(wrongIssuer)).toThrow(/issuer/i)
  })

  it('uses validated env JWT_ISSUER and JWT_AUDIENCE values', () => {
    const { env } = validateEnv({
      DATABASE_URL: 'postgresql://disciplr:disciplr@localhost:5432/disciplr',
      JWT_ACCESS_SECRET: ACCESS_SECRET,
      JWT_REFRESH_SECRET: REFRESH_SECRET,
      JWT_ISSUER: 'disciplr-staging',
      JWT_AUDIENCE: 'disciplr-staging-api',
    })

    const token = generateAccessToken({ userId: 'user-2', role: 'VERIFIER' }, env)
    const decoded = jwt.decode(token) as jwt.JwtPayload
    expect(decoded.iss).toBe('disciplr-staging')
    expect(decoded.aud).toBe('disciplr-staging-api')

    expect(verifyAccessToken(token, env).userId).toBe('user-2')
    expect(() => verifyAccessToken(token)).toThrow(/issuer|audience/i)
  })

  it('preserves kid rotation while enforcing aud/iss on every rotated key', () => {
    process.env.JWT_KEYS = JSON.stringify([
      { kid: 'current', secret: 'current-key-secret' },
      { kid: 'previous', secret: 'previous-key-secret' },
    ])

    const rotatedToken = signAccessToken(
      { sub: 'user-3', userId: 'user-3', role: 'USER' },
      'previous-key-secret',
      {
        issuer: 'disciplr',
        audience: 'disciplr-api',
        header: { kid: 'previous' },
      },
    )
    expect(verifyAccessToken(rotatedToken).userId).toBe('user-3')

    const wrongAudience = signAccessToken(
      { sub: 'user-3', userId: 'user-3', role: 'USER' },
      'previous-key-secret',
      {
        issuer: 'disciplr',
        audience: 'admin-api',
        header: { kid: 'previous' },
      },
    )
    expect(() => verifyAccessToken(wrongAudience)).toThrow(/audience/i)
  })

  it('requires aud/iss on refresh token verification too', () => {
    const token = generateRefreshToken({ userId: 'user-4' })
    expect(verifyRefreshToken(token).userId).toBe('user-4')

    const missingClaims = jwt.sign({ userId: 'user-4' }, REFRESH_SECRET, {
      expiresIn: '7d',
    })
    const wrongIssuer = jwt.sign({ userId: 'user-4' }, REFRESH_SECRET, {
      expiresIn: '7d',
      issuer: 'other-service',
      audience: 'disciplr-api',
    })

    expect(() => verifyRefreshToken(missingClaims)).toThrow(/issuer|audience/i)
    expect(() => verifyRefreshToken(wrongIssuer)).toThrow(/issuer/i)
  })
})
