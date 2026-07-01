import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

// ── Mocks ─────────────────────────────────────────────────────────────────────

const dbMock: any = jest.fn()
dbMock._rows = [] as any[]
dbMock._pending = null

dbMock.mockImplementation((table: string) => {
  const qb: any = {
    _table: table,
    insert: jest.fn().mockImplementation((row: any) => {
      dbMock._rows.push({ ...row, id: crypto.randomUUID() })
      qb._inserted = row
      return qb
    }),
    returning: jest.fn().mockImplementation(() => {
      const inserted = dbMock._rows[dbMock._rows.length - 1]
      return Promise.resolve([inserted])
    }),
    where: jest.fn().mockReturnThis(),
    whereNull: jest.fn().mockReturnThis(),
    first: jest.fn().mockImplementation(() => {
      return Promise.resolve(dbMock._pending ?? null)
    }),
    update: jest.fn().mockResolvedValue(1),
  }
  return qb
})

jest.unstable_mockModule('../db/index.js', async () => ({ default: dbMock }))
jest.unstable_mockModule('../lib/audit-logs.js', async () => ({ createAuditLog: jest.fn() }))

jest.unstable_mockModule('../services/notifications/factory.js', async () => ({
  buildNotificationProviderRegistry: jest.fn(() => ({
    console: { send: jest.fn().mockResolvedValue(undefined) },
  })),
}))

jest.unstable_mockModule('../services/membership.js', async () => ({
  listOrgMemberships: jest.fn(),
  createMembership: jest.fn().mockResolvedValue({ role: 'member' }),
  removeMembership: jest.fn(),
  updateMemberRole: jest.fn(),
  resendInvitation: jest.fn(),
  revokeInvitation: jest.fn(),
  InvitationNotFoundError: class InvitationNotFoundError extends Error {},
  InvitationAcceptedError: class InvitationAcceptedError extends Error {},
  LastAdminError: class LastAdminError extends Error {},
}))

jest.unstable_mockModule('../middleware/orgAuth.js', async () => ({
  requireOrgAccess: (..._roles: string[]) =>
    (_req: Request, _res: Response, next: NextFunction) => next(),
}))

// ── Test app setup ────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

function makeToken(userId = 'user-1', role = 'admin') {
  return jwt.sign({ userId, role, sub: userId }, JWT_SECRET)
}

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Patch authenticate before importing router
jest.unstable_mockModule('../middleware/auth.js', async () => ({ authenticate: mockAuthenticate }))

// Must import AFTER mocks
const { orgMembersRouter } = await import('../routes/orgMembers.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const app = express()
app.use(express.json())
app.use('/api/organizations', orgMembersRouter)
app.use(errorHandler)

// ── Helpers ─────────────────────────────────────────────────────────────────--

function seedPendingInvitation(tokenHash: string, orgId = 'org-abc') {
  dbMock._pending = {
    id: 'inv-1',
    org_id: orgId,
    email: 'invitee@example.com',
    token_hash: tokenHash,
    expires_at: new Date(Date.now() + 86400_000),
    accepted_at: null,
  }
}

// ── POST /api/organizations/:orgId/invitations ────────────────────────────────

describe('POST /api/organizations/:orgId/invitations', () => {
  beforeEach(() => {
    dbMock._rows = []
    dbMock._pending = null
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations')
      .send({ email: 'a@b.com' })
    expect(res.status).toBe(401)
  })

  it('returns 400 when email is missing', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({})
    expect(res.status).toBe(400)
  })

  it('returns 400 when email is malformed', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ email: 'not-an-email' })
    expect(res.status).toBe(400)
  })

  it('creates invitation and returns token on success', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ email: 'invitee@example.com' })

    expect(res.status).toBe(201)
    expect(res.body).toHaveProperty('token')
    expect(res.body.token).toHaveLength(64) // 32 bytes hex
    expect(res.body.email).toBe('invitee@example.com')
    expect(res.body.orgId).toBe('org-abc')
    expect(res.body).toHaveProperty('expiresAt')
  })

  it('token is a 64-char hex string', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ email: 'invitee@example.com' })

    expect(res.status).toBe(201)
    expect(/^[0-9a-f]{64}$/.test(res.body.token)).toBe(true)
  })
})

// ── POST /api/organizations/:orgId/invitations/accept ────────────────────────

describe('POST /api/organizations/:orgId/invitations/accept', () => {
  beforeEach(() => {
    dbMock._rows = []
    dbMock._pending = null
  })

  it('returns 400 when token is missing', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ userId: 'user-2' })
    expect(res.status).toBe(400)
  })

  it('returns 400 when userId is missing', async () => {
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ token: 'abc' })
    expect(res.status).toBe(400)
  })

  it('returns 400 for invalid/expired token', async () => {
    // No pending invitation seeded → db returns null
    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ token: 'deadbeef'.repeat(8), userId: 'user-2' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/invalid or expired/i)
  })

  it('returns 400 when token hash does not match', async () => {
    // Seed invitation with a different token hash
    seedPendingInvitation('a'.repeat(64))

    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ token: 'b'.repeat(64), userId: 'user-2' })
    expect(res.status).toBe(400)
  })

  it('accepts valid token and creates membership', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    seedPendingInvitation(tokenHash)

    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ token: rawToken, userId: 'user-2' })

    expect(res.status).toBe(200)
    expect(res.body.orgId).toBe('org-abc')
    expect(res.body.userId).toBe('user-2')
    expect(res.body.role).toBe('member')
  })

  it('defaults role to member when not specified', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    seedPendingInvitation(tokenHash)

    const res = await request(app)
      .post('/api/organizations/org-abc/invitations/accept')
      .send({ token: rawToken, userId: 'user-2' })

    expect(res.status).toBe(200)
    expect(res.body.role).toBe('member')
  })
})
