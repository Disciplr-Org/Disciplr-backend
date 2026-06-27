import { describe, test, expect, beforeEach } from '@jest/globals'
import express, { Request, Response, NextFunction } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { enterpriseGuard } from '../middleware/enterpriseGuard.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { enforceRBAC } from '../middleware/rbac.js'
import { setOrganizations, setOrgMembers } from '../models/organizations.js'
import { UserRole } from '../types/user.js'
import type { JWTPayload } from '../types/auth.js'

const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || 'fallback-access-secret'

/**
 * Build a signed access token that includes enterprise claims.
 * generateAccessToken from lib/auth-utils does not expose isEnterprise/enterpriseId,
 * so this helper signs directly with the same fallback secret used in tests.
 */
function makeEnterpriseToken(payload: Partial<JWTPayload> & { userId: string; role: UserRole }): string {
  return jwt.sign(
    {
      sub: payload.userId,
      userId: payload.userId,
      role: payload.role,
      ...(payload.isEnterprise !== undefined && { isEnterprise: payload.isEnterprise }),
      ...(payload.enterpriseId !== undefined && { enterpriseId: payload.enterpriseId }),
    },
    ACCESS_SECRET,
    { expiresIn: '15m' },
  )
}

/**
 * Test-only middleware that decodes a Bearer token and attaches req.user.
 * This simulates the authentication layer so enterpriseGuard can be tested in isolation.
 */
function testAuthenticator(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next()
    return
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), ACCESS_SECRET) as JWTPayload
  } catch {
    // leave user unset so downstream authz returns 401
  }
  next()
}

function buildApp(
  middleware: Array<(req: Request, res: Response, next: NextFunction) => unknown>,
  path = '/enterprise',
) {
  const app = express()
  app.use(express.json())
  app.use(testAuthenticator)
  app.get(path, ...middleware, (_req, res) => res.status(200).json({ ok: true }))
  return app
}

describe('enterpriseGuard feature-gating and exposure', () => {
  beforeEach(() => {
    setOrganizations([])
    setOrgMembers([])
  })

  describe('authentication before authorization', () => {
    test('returns 401 when request is unauthenticated', async () => {
      const app = buildApp([enterpriseGuard])

      const response = await request(app).get('/enterprise')

      expect(response.status).toBe(401)
      expect(response.body.error).toBe('Unauthorized')
      expect(response.body.message).toBe('Authentication required')
    })

    test('returns 401 with malformed bearer token', async () => {
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', 'Bearer not-a-real-token')

      expect(response.status).toBe(401)
    })
  })

  describe('enterprise tier gating', () => {
    test('allows enterprise user with enterpriseId', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'ent-user-1',
        role: UserRole.USER,
        isEnterprise: true,
        enterpriseId: 'ent_123',
      })
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(200)
      expect(response.body.ok).toBe(true)
    })

    test('denies non-enterprise user with 403', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'non-ent-user-1',
        role: UserRole.USER,
        isEnterprise: false,
      })
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.error).toBe('Forbidden')
      expect(response.body.message).toBe('This endpoint is restricted to enterprise accounts.')
    })

    test('denies enterprise user missing enterpriseId', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'ent-user-2',
        role: UserRole.USER,
        isEnterprise: true,
      })
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.message).toBe('Enterprise configuration missing in auth context.')
    })
  })

  describe('fail-closed behavior', () => {
    test('denies when isEnterprise is undefined', async () => {
      const accessJwt = jwt.sign(
        { sub: 'ambiguous-user', userId: 'ambiguous-user', role: UserRole.USER },
        ACCESS_SECRET,
        { expiresIn: '15m' },
      )
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.error).toBe('Forbidden')
    })

    test('denies when isEnterprise is explicitly false', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'explicit-false-user',
        role: UserRole.USER,
        isEnterprise: false,
      })
      const app = buildApp([enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
    })

    test('each request is evaluated independently (tier downgrade mid-session)', async () => {
      const enterpriseJwt = makeEnterpriseToken({
        userId: 'downgrade-user',
        role: UserRole.USER,
        isEnterprise: true,
        enterpriseId: 'ent_456',
      })
      const downgradedJwt = makeEnterpriseToken({
        userId: 'downgrade-user',
        role: UserRole.USER,
        isEnterprise: false,
      })
      const app = buildApp([enterpriseGuard])

      const first = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${enterpriseJwt}`)
      expect(first.status).toBe(200)

      const second = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${downgradedJwt}`)
      expect(second.status).toBe(403)
    })
  })

  describe('interaction with orgAuth', () => {
    beforeEach(() => {
      setOrganizations([
        { id: 'org_1', name: 'Test Org', createdAt: new Date().toISOString() },
      ])
      setOrgMembers([
        { orgId: 'org_1', userId: 'org-member-ent', role: 'member' },
        { orgId: 'org_1', userId: 'org-member-non-ent', role: 'member' },
      ])
    })

    test('orgAuth passes and enterpriseGuard denies non-enterprise member', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'org-member-non-ent',
        role: UserRole.USER,
        isEnterprise: false,
      })
      const app = buildApp([requireOrgAccess('member'), enterpriseGuard], '/:orgId/enterprise')

      const response = await request(app)
        .get('/org_1/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.message).toBe('This endpoint is restricted to enterprise accounts.')
    })

    test('orgAuth denies non-member before enterpriseGuard runs', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'not-a-member',
        role: UserRole.USER,
        isEnterprise: true,
        enterpriseId: 'ent_789',
      })
      const app = buildApp([requireOrgAccess('member'), enterpriseGuard], '/:orgId/enterprise')

      const response = await request(app)
        .get('/org_1/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.error).toBe('Forbidden: not a member of this organization')
    })

    test('orgAuth and enterpriseGuard both pass for enterprise org member', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'org-member-ent',
        role: UserRole.USER,
        isEnterprise: true,
        enterpriseId: 'ent_abc',
      })
      const app = buildApp([requireOrgAccess('member'), enterpriseGuard], '/:orgId/enterprise')

      const response = await request(app)
        .get('/org_1/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(200)
    })
  })

  describe('interaction with rbac', () => {
    test('rbac denies insufficient role before enterpriseGuard runs', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'admin-only-user',
        role: UserRole.USER,
        isEnterprise: true,
        enterpriseId: 'ent_def',
      })
      const app = buildApp([enforceRBAC({ allow: [UserRole.ADMIN] }), enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.message).toBe('Requires role: ADMIN')
    })

    test('rbac passes and enterpriseGuard denies non-enterprise admin', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'admin-non-ent',
        role: UserRole.ADMIN,
        isEnterprise: false,
      })
      const app = buildApp([enforceRBAC({ allow: [UserRole.ADMIN] }), enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(403)
      expect(response.body.message).toBe('This endpoint is restricted to enterprise accounts.')
    })

    test('rbac and enterpriseGuard both pass for enterprise admin', async () => {
      const accessJwt = makeEnterpriseToken({
        userId: 'admin-ent',
        role: UserRole.ADMIN,
        isEnterprise: true,
        enterpriseId: 'ent_ghi',
      })
      const app = buildApp([enforceRBAC({ allow: [UserRole.ADMIN] }), enterpriseGuard])

      const response = await request(app)
        .get('/enterprise')
        .set('Authorization', `Bearer ${accessJwt}`)

      expect(response.status).toBe(200)
    })
  })
})
