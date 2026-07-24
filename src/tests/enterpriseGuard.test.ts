/**
 * Unit tests for src/middleware/enterpriseGuard.ts  (issue #858)
 *
 * Coverage matrix:
 * ─────────────────────────────────────────────────────────────────────────────
 *  Scenario                                      Expected HTTP status
 * ─────────────────────────────────────────────────────────────────────────────
 *  Unauthenticated (no req.user)                 401
 *  Non-enterprise org (isEnterprise: false)       403
 *  isEnterprise missing / undefined              403  (fail-closed)
 *  isEnterprise: true but no enterpriseId        403  (misconfiguration)
 *  Enterprise org, valid enterpriseId            200  (passes through)
 *  Authentication checked before authorization   401 before 403
 *  Tier downgrade mid-session                    403
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The tests use a minimal Express app built on top of the real middleware so
 * no internal implementation details are coupled.
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { enterpriseGuard } from '../middleware/enterpriseGuard.js'
import type { AuthenticatedRequest } from '../middleware/auth.js'
import type { JWTPayload } from '../types/auth.js'
import { UserRole } from '../types/user.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

/** Build a signed JWT; individual fields can be overridden per-test. */
function makeToken(payload: Partial<JWTPayload> = {}): string {
  return jwt.sign(
    {
      userId: 'user-1',
      role: UserRole.USER,
      ...payload,
    },
    JWT_SECRET,
    { expiresIn: '1h' },
  )
}

/**
 * Build a minimal Express app that:
 *   1. Injects `req.user` from a pre-built token (simulating authenticate())
 *   2. Runs enterpriseGuard
 *   3. Returns 200 { ok: true } if guard passes
 *
 * Injecting the decoded user directly (rather than through a real JWT verify)
 * keeps tests self-contained and avoids coupling to the JWT library internals.
 */
function buildApp(user: JWTPayload | undefined) {
  const app = express()
  app.use(express.json())

  // Simulate authenticate() injecting req.user
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (user !== undefined) {
      (req as AuthenticatedRequest).user = user
    }
    next()
  })

  // Guard under test
  app.get('/enterprise', enterpriseGuard, (_req: Request, res: Response) => {
    res.status(200).json({ ok: true })
  })

  return app
}

// ─── Unauthenticated ──────────────────────────────────────────────────────────

describe('enterpriseGuard — unauthenticated', () => {
  it('returns 401 when req.user is not set (no authentication middleware ran)', async () => {
    const app = buildApp(undefined) // no user injected
    const res = await request(app).get('/enterprise')
    expect(res.status).toBe(401)
    expect(res.body.error).toBe('Unauthorized')
  })

  it('401 response includes a message indicating authentication is required', async () => {
    const app = buildApp(undefined)
    const res = await request(app).get('/enterprise')
    expect(res.body.message).toMatch(/authentication required/i)
  })
})

// ─── Authentication ordering (401 before 403) ─────────────────────────────────

describe('enterpriseGuard — auth-before-authz ordering', () => {
  it('emits 401 (not 403) when the request is completely unauthenticated', async () => {
    // If auth guard accidentally short-circuits to 403 before checking login
    // state, this test catches the regression.
    const app = buildApp(undefined)
    const res = await request(app).get('/enterprise')
    expect(res.status).toBe(401)
    expect(res.status).not.toBe(403)
  })
})

// ─── Non-enterprise orgs ──────────────────────────────────────────────────────

describe('enterpriseGuard — non-enterprise org', () => {
  it('returns 403 when isEnterprise is false', async () => {
    const user: JWTPayload = { userId: 'u1', role: UserRole.USER, isEnterprise: false }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('Forbidden')
  })

  it('returns 403 when isEnterprise is explicitly false even if enterpriseId is set', async () => {
    // enterpriseId present but flag is false — guard must honour the flag
    const user: JWTPayload = {
      userId: 'u2',
      role: UserRole.USER,
      isEnterprise: false,
      enterpriseId: 'enterprise-123',
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
  })

  it('response body contains a human-readable restriction message', async () => {
    const user: JWTPayload = { userId: 'u3', role: UserRole.USER, isEnterprise: false }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.body.message).toMatch(/enterprise/i)
  })
})

// ─── Fail-closed on missing / ambiguous tier ──────────────────────────────────

describe('enterpriseGuard — fail-closed behaviour', () => {
  it('returns 403 when isEnterprise is undefined (missing from JWT)', async () => {
    // isEnterprise deliberately omitted — must default to deny
    const user: JWTPayload = { userId: 'u4', role: UserRole.USER }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
  })

  it('returns 403 when isEnterprise is null-ish (treated as falsy)', async () => {
    const user = { userId: 'u5', role: UserRole.USER, isEnterprise: null } as unknown as JWTPayload
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
  })

  it('returns 403 when enterpriseId is absent even though isEnterprise is true (misconfiguration)', async () => {
    // isEnterprise flag is set but no enterpriseId — must be denied (fail-closed)
    const user: JWTPayload = {
      userId: 'u6',
      role: UserRole.USER,
      isEnterprise: true,
      // enterpriseId intentionally omitted
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
    expect(res.body.message).toMatch(/enterprise configuration missing/i)
  })

  it('returns 403 when enterpriseId is an empty string (misconfiguration)', async () => {
    const user: JWTPayload = {
      userId: 'u7',
      role: UserRole.USER,
      isEnterprise: true,
      enterpriseId: '',
    }
    // Empty string is falsy — should still be blocked
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
  })
})

// ─── Enterprise org — allowed ─────────────────────────────────────────────────

describe('enterpriseGuard — enterprise org allowed', () => {
  it('calls next() and returns 200 for a valid enterprise user', async () => {
    const user: JWTPayload = {
      userId: 'u8',
      role: UserRole.USER,
      isEnterprise: true,
      enterpriseId: 'enterprise-org-1',
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('allows enterprise ADMIN users through', async () => {
    const user: JWTPayload = {
      userId: 'admin-1',
      role: UserRole.ADMIN,
      isEnterprise: true,
      enterpriseId: 'enterprise-org-2',
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(200)
  })

  it('allows enterprise VERIFIER users through', async () => {
    const user: JWTPayload = {
      userId: 'verifier-1',
      role: UserRole.VERIFIER,
      isEnterprise: true,
      enterpriseId: 'enterprise-org-3',
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(200)
  })
})

// ─── Tier downgrade mid-session ───────────────────────────────────────────────

describe('enterpriseGuard — tier downgrade mid-session', () => {
  it('denies access when the user tier is downgraded (isEnterprise flipped to false)', async () => {
    // Simulate a JWT re-issued after a downgrade event by replacing the user
    // object between requests (the middleware re-reads req.user each time).
    const downgradeUser: JWTPayload = {
      userId: 'u9',
      role: UserRole.USER,
      isEnterprise: false, // was true, now downgraded
      enterpriseId: 'enterprise-org-old',
    }
    const res = await request(buildApp(downgradeUser)).get('/enterprise')
    expect(res.status).toBe(403)
  })

  it('denies access when enterpriseId is removed after downgrade', async () => {
    const downgradeUser: JWTPayload = {
      userId: 'u10',
      role: UserRole.USER,
      isEnterprise: true,
      // enterpriseId removed during tier downgrade
    }
    const res = await request(buildApp(downgradeUser)).get('/enterprise')
    expect(res.status).toBe(403)
  })
})

// ─── Interaction with orgAuth / rbac ──────────────────────────────────────────

describe('enterpriseGuard — interaction with orgAuth and rbac', () => {
  /**
   * When enterpriseGuard is stacked after a role-based check, a non-enterprise
   * user with a high-privilege role must still be blocked by enterpriseGuard.
   */
  it('blocks a non-enterprise ADMIN — role alone is not sufficient', async () => {
    const user: JWTPayload = {
      userId: 'admin-non-ent',
      role: UserRole.ADMIN,
      isEnterprise: false,
    }
    const res = await request(buildApp(user)).get('/enterprise')
    expect(res.status).toBe(403)
  })

  /**
   * enterpriseGuard is an additional layer — it should not bypass or replace
   * authentication. Test that the guard's 401 path is reachable regardless of
   * what role-enforcement would have said.
   */
  it('always checks authentication first regardless of role context', async () => {
    // No user at all — unauthenticated path must win
    const app = buildApp(undefined)
    const res = await request(app).get('/enterprise')
    expect(res.status).toBe(401)
    expect(res.status).not.toBe(403)
  })

  it('logs a warning for non-enterprise denials (security audit trail)', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const user: JWTPayload = {
      userId: 'u11',
      role: UserRole.USER,
      isEnterprise: false,
    }
    await request(buildApp(user)).get('/enterprise')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('security.enterprise_denied'),
    )
    warnSpy.mockRestore()
  })
})
