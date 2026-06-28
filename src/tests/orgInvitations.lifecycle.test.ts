import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'
const sendMock = jest.fn().mockResolvedValue(undefined)
const auditMock = jest.fn().mockResolvedValue(undefined)

type InvitationRow = {
  id: string
  org_id: string
  email: string
  token_hash: string
  expires_at: Date
  accepted_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

type Condition =
  | { type: 'match'; values: Record<string, unknown> }
  | { type: 'null'; key: string }
  | { type: 'gt'; key: string; value: unknown }

const dbMock: any = jest.fn()
dbMock._tables = {
  org_invitations: [] as InvitationRow[],
  memberships: [] as any[],
}
dbMock._failFirst = false
dbMock._failUpdate = false

function matches(row: Record<string, any>, conditions: Condition[]) {
  return conditions.every((condition) => {
    if (condition.type === 'match') {
      return Object.entries(condition.values).every(([key, value]) => row[key] === value)
    }
    if (condition.type === 'null') {
      return row[condition.key] === null || typeof row[condition.key] === 'undefined'
    }
    return new Date(row[condition.key]).getTime() > new Date(condition.value as any).getTime()
  })
}

dbMock.mockImplementation((table: keyof typeof dbMock._tables) => {
  const conditions: Condition[] = []
  let updatedRows: any[] = []
  let insertedRows: any[] = []

  const qb: any = {
    insert: jest.fn().mockImplementation((row: any) => {
      const inserted = {
        ...row,
        id: row.id ?? crypto.randomUUID(),
        accepted_at: row.accepted_at ?? null,
        revoked_at: row.revoked_at ?? null,
        created_at: row.created_at ?? new Date(),
      }
      dbMock._tables[table].push(inserted)
      insertedRows = [inserted]
      return qb
    }),
    returning: jest.fn().mockImplementation(() => {
      return Promise.resolve(updatedRows.length > 0 ? updatedRows : insertedRows)
    }),
    where: jest.fn().mockImplementation((keyOrValues: any, operator?: string, value?: unknown) => {
      if (typeof keyOrValues === 'string' && operator === '>') {
        conditions.push({ type: 'gt', key: keyOrValues, value })
      } else {
        conditions.push({ type: 'match', values: keyOrValues })
      }
      return qb
    }),
    whereNull: jest.fn().mockImplementation((key: string) => {
      conditions.push({ type: 'null', key })
      return qb
    }),
    first: jest.fn().mockImplementation(() => {
      if (dbMock._failFirst) {
        return Promise.reject(new Error('database unavailable'))
      }
      return Promise.resolve(dbMock._tables[table].find((row: any) => matches(row, conditions)) ?? null)
    }),
    update: jest.fn().mockImplementation((patch: Record<string, unknown>) => {
      if (dbMock._failUpdate) {
        throw new Error('database unavailable')
      }
      updatedRows = []
      for (const row of dbMock._tables[table]) {
        if (matches(row, conditions)) {
          Object.assign(row, patch)
          updatedRows.push(row)
        }
      }
      return qb
    }),
  }

  return qb
})

jest.unstable_mockModule('../db/index.js', async () => ({ default: dbMock }))
jest.unstable_mockModule('../lib/audit-logs.js', async () => ({ createAuditLog: auditMock }))
jest.unstable_mockModule('../services/notifications/factory.js', async () => ({
  buildNotificationProviderRegistry: jest.fn(() => ({
    console: { send: sendMock },
  })),
}))

function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return
  }

  req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as any
  next()
}

jest.unstable_mockModule('../middleware/auth.js', async () => ({ authenticate: mockAuthenticate }))
jest.unstable_mockModule('../middleware/orgAuth.js', async () => ({
  requireOrgAccess: (...roles: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      if (!roles.includes((req.user as any)?.role)) {
        res.status(403).json({ error: `Forbidden: requires role ${roles.join(' or ')}` })
        return
      }
      next()
    },
}))

const { orgMembersRouter } = await import('../routes/orgMembers.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

const app = express()
app.use(express.json())
app.use('/api/orgs', orgMembersRouter)
app.use(errorHandler)

function makeToken(userId = 'admin-1', role = 'admin') {
  return jwt.sign({ userId, role, sub: userId }, JWT_SECRET)
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function seedInvitation(overrides: Partial<InvitationRow> = {}) {
  const rawToken = overrides.token_hash ? undefined : crypto.randomBytes(32).toString('hex')
  const row: InvitationRow = {
    id: 'inv-1',
    org_id: 'org-abc',
    email: 'invitee@example.com',
    token_hash: overrides.token_hash ?? hashToken(rawToken!),
    expires_at: new Date(Date.now() + 86_400_000),
    accepted_at: null,
    revoked_at: null,
    created_at: new Date(),
    ...overrides,
  }
  dbMock._tables.org_invitations.push(row)
  return { row, rawToken }
}

beforeEach(() => {
  dbMock._tables.org_invitations = []
  dbMock._tables.memberships = []
  dbMock._failFirst = false
  dbMock._failUpdate = false
  sendMock.mockClear()
  auditMock.mockClear()
})

describe('organization invitation lifecycle', () => {
  it('resends with a fresh token and invalidates the previous token', async () => {
    const { rawToken: oldToken } = seedInvitation()

    const resend = await request(app)
      .post('/api/orgs/org-abc/invitations/inv-1/resend')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(resend.status).toBe(200)
    expect(resend.body.token).toHaveLength(64)
    expect(resend.body.token).not.toBe(oldToken)
    expect(dbMock._tables.org_invitations[0].token_hash).toBe(hashToken(resend.body.token))
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'org.invitation.resent' }))

    const oldAccept = await request(app)
      .post('/api/orgs/org-abc/invitations/accept')
      .send({ token: oldToken, userId: 'user-2' })

    expect(oldAccept.status).toBe(400)

    const newAccept = await request(app)
      .post('/api/orgs/org-abc/invitations/accept')
      .send({ token: resend.body.token, userId: 'user-2' })

    expect(newAccept.status).toBe(200)
    expect(newAccept.body).toMatchObject({ orgId: 'org-abc', userId: 'user-2', role: 'member' })
  })

  it('revokes a pending invitation and blocks acceptance', async () => {
    const { rawToken } = seedInvitation()

    const revoke = await request(app)
      .delete('/api/orgs/org-abc/invitations/inv-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(revoke.status).toBe(200)
    expect(revoke.body.revokedAt).toBeTruthy()
    expect(dbMock._tables.org_invitations[0].revoked_at).toBeInstanceOf(Date)
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'org.invitation.revoked' }))

    const accept = await request(app)
      .post('/api/orgs/org-abc/invitations/accept')
      .send({ token: rawToken, userId: 'user-2' })

    expect(accept.status).toBe(400)
  })

  it('returns 409 when revoking an accepted invitation', async () => {
    seedInvitation({ accepted_at: new Date() })

    const res = await request(app)
      .delete('/api/orgs/org-abc/invitations/inv-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(409)
  })

  it('returns 409 when resending an accepted invitation', async () => {
    seedInvitation({ accepted_at: new Date() })

    const res = await request(app)
      .post('/api/orgs/org-abc/invitations/inv-1/resend')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(409)
  })

  it('returns 404 when resending a missing invitation', async () => {
    const res = await request(app)
      .post('/api/orgs/org-abc/invitations/missing/resend')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(404)
  })

  it('returns 404 when revoking a missing invitation', async () => {
    const res = await request(app)
      .delete('/api/orgs/org-abc/invitations/missing')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(404)
  })

  it('returns 500 when resend persistence fails unexpectedly', async () => {
    seedInvitation()
    dbMock._failUpdate = true

    const res = await request(app)
      .post('/api/orgs/org-abc/invitations/inv-1/resend')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(500)
  })

  it('returns 500 when revoke persistence fails unexpectedly', async () => {
    seedInvitation()
    dbMock._failUpdate = true

    const res = await request(app)
      .delete('/api/orgs/org-abc/invitations/inv-1')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send()

    expect(res.status).toBe(500)
  })

  it('enforces org-admin RBAC on resend and revoke', async () => {
    seedInvitation()

    const resend = await request(app)
      .post('/api/orgs/org-abc/invitations/inv-1/resend')
      .set('Authorization', `Bearer ${makeToken('member-1', 'member')}`)
      .send()

    const revoke = await request(app)
      .delete('/api/orgs/org-abc/invitations/inv-1')
      .set('Authorization', `Bearer ${makeToken('member-1', 'member')}`)
      .send()

    expect(resend.status).toBe(403)
    expect(revoke.status).toBe(403)
  })
})
