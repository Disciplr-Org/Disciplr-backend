import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import request from 'supertest'
import express, { type Request, type Response, type NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import crypto from 'crypto'
import {
  setOrganizations,
  setOrgMembers,
  getOrgMembers,
  getMemberRole,
  addOrgMember,
  type OrgRole,
} from '../models/organizations.js'

// ─────────────────────────────────────────────────────────────────────────────
// End-to-end org-member invitation acceptance flow (issue #668).
//
// `orgInvitations.test.ts` and `orgInvitations.lifecycle.test.ts` cover the
// invitation routes in isolation (token issuance, accept validation, resend,
// revoke) with membership and org access fully stubbed. None of them exercise
// the *seam* between accepting an invitation and the tenant-scoped authorization
// that should follow.
//
// This suite walks the whole journey through the real router and the real
// `requireOrgAccess` middleware: an admin issues an invitation, the invitee
// accepts it with the raw token, becomes a scoped member, and can then read
// *only* that org's resources — never another org's (cross-tenant isolation).
// It also proves an expired or already-accepted token is rejected at acceptance.
//
// Only the external boundaries are mocked: the JWT/session auth middleware, the
// notification provider, audit logging, the Postgres-backed `org_invitations`
// table, and the membership service. Crucially, `createMembership` is backed by
// the same in-memory organizations model that `requireOrgAccess` reads, so the
// acceptance genuinely grants access that the later vault requests observe.
//
// `jest.unstable_mockModule` + dynamic import is required because this project
// runs Jest in native-ESM mode (see `useESM` in jest.config.cjs).
// ─────────────────────────────────────────────────────────────────────────────

const sha256 = (token: string) => crypto.createHash('sha256').update(token).digest('hex')

// ── In-memory `org_invitations` table behind a minimal knex-like query builder ─
interface InvitationRow {
  id: string
  org_id: string
  email: string
  token_hash: string
  expires_at: Date
  accepted_at: Date | null
  revoked_at: Date | null
}

const invitations: InvitationRow[] = []

function makeQueryBuilder() {
  const eqFilters: Record<string, unknown> = {}
  const nullCols: string[] = []
  let gtFilter: { col: string; value: Date } | null = null
  let pendingInsert: Partial<InvitationRow> | null = null

  const matches = (row: InvitationRow) =>
    Object.entries(eqFilters).every(([k, v]) => (row as any)[k] === v) &&
    nullCols.every((c) => (row as any)[c] == null) &&
    (!gtFilter || new Date((row as any)[gtFilter.col]) > gtFilter.value)

  const qb: any = {
    insert(row: Partial<InvitationRow>) {
      pendingInsert = row
      return qb
    },
    returning() {
      const rec: InvitationRow = {
        id: crypto.randomUUID(),
        accepted_at: null,
        revoked_at: null,
        ...(pendingInsert as InvitationRow),
      }
      invitations.push(rec)
      return Promise.resolve([rec])
    },
    where(arg: any, op?: string, value?: Date) {
      if (typeof arg === 'object') Object.assign(eqFilters, arg)
      else if (op === '>' && value !== undefined) gtFilter = { col: arg, value }
      return qb
    },
    whereNull(col: string) {
      nullCols.push(col)
      return qb
    },
    first() {
      return Promise.resolve(invitations.find(matches) ?? null)
    },
    update(patch: Partial<InvitationRow>) {
      const row = invitations.find(matches)
      if (row) Object.assign(row, patch)
      return Promise.resolve(row ? 1 : 0)
    },
  }
  return qb
}

const dbMock: any = jest.fn(() => makeQueryBuilder())

jest.unstable_mockModule('../db/index.js', async () => ({ default: dbMock }))
jest.unstable_mockModule('../lib/audit-logs.js', async () => ({ createAuditLog: jest.fn() }))
jest.unstable_mockModule('../services/notifications/factory.js', async () => ({
  buildNotificationProviderRegistry: jest.fn(() => ({
    console: { send: jest.fn<any>().mockResolvedValue(undefined) },
  })),
}))

// Membership service mock: `createMembership` persists into the in-memory model
// so the acceptance is observable by the real `requireOrgAccess` middleware.
jest.unstable_mockModule('../services/membership.js', async () => ({
  createMembership: jest.fn(async (input: any) => {
    addOrgMember({
      orgId: input.organization_id,
      userId: input.user_id,
      role: (input.role ?? 'member') as OrgRole,
    })
    return { role: input.role ?? 'member' }
  }),
  listOrgMemberships: jest.fn(async (orgId: string) =>
    getOrgMembers(orgId).map((m) => ({
      id: `${m.orgId}:${m.userId}`,
      user_id: m.userId,
      organization_id: m.orgId,
      team_id: null,
      role: m.role,
    })),
  ),
  removeMembership: jest.fn(),
  changeRole: jest.fn(),
  transferOwnership: jest.fn(),
  resendInvitation: jest.fn(),
  revokeInvitation: jest.fn(),
  LastAdminError: class LastAdminError extends Error {},
  InvitationNotFoundError: class InvitationNotFoundError extends Error {},
  InvitationAcceptedError: class InvitationAcceptedError extends Error {},
}))

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

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

jest.unstable_mockModule('../middleware/auth.js', async () => ({ authenticate: mockAuthenticate }))

// Imports that pull in the mocked modules must happen after the mocks above.
const { orgMembersRouter } = await import('../routes/orgMembers.js')
const { errorHandler } = await import('../middleware/errorHandler.js')

// ── Test app: just the real router (which carries its own auth + org-access) ───
// Scoped access is verified through the router's real `GET /:orgId/members`
// route — itself guarded by `requireOrgAccess` — so the test never defines its
// own authorization endpoint.
const app = express()
app.use(express.json())
app.use('/api/organizations', orgMembersRouter)
app.use(errorHandler)

// Reads an org's member roster as `userId`; this is the org-scoped resource the
// real `requireOrgAccess` middleware gates.
const readRoster = (orgId: string, userId: string, role = 'member') =>
  request(app)
    .get(`/api/organizations/${orgId}/members`)
    .set('Authorization', bearer(userId, role))

const bearer = (userId: string, role = 'member') =>
  `Bearer ${jwt.sign({ userId, role, sub: userId }, JWT_SECRET, { expiresIn: '1h' })}`

const ORG_ALPHA = 'org-alpha'
const ORG_BETA = 'org-beta'

beforeEach(() => {
  invitations.length = 0
  setOrganizations([
    { id: ORG_ALPHA, name: 'Alpha Corp', createdAt: '2025-01-01T00:00:00Z' },
    { id: ORG_BETA, name: 'Beta Inc', createdAt: '2025-02-01T00:00:00Z' },
  ])
  setOrgMembers([
    { orgId: ORG_ALPHA, userId: 'alice', role: 'owner' },
    { orgId: ORG_BETA, userId: 'dave', role: 'owner' },
  ])
})

afterEach(() => {
  invitations.length = 0
  setOrganizations([])
  setOrgMembers([])
  jest.clearAllMocks()
})

// Issues an invitation as an org admin and returns the raw acceptance token.
async function inviteToAlpha(email = 'erin@example.com'): Promise<string> {
  const res = await request(app)
    .post(`/api/organizations/${ORG_ALPHA}/invitations`)
    .set('Authorization', bearer('alice', 'owner'))
    .send({ email })
  expect(res.status).toBe(201)
  expect(res.body.token).toMatch(/^[0-9a-f]{64}$/)
  return res.body.token
}

describe('Org-member invitation acceptance — end to end (issue #668)', () => {
  it('walks invite → accept → scoped member → org-scoped resource access', async () => {
    // Before acceptance, the invitee is not a member and is denied org access.
    const before = await readRoster(ORG_ALPHA, 'erin')
    expect(before.status).toBe(403)

    // 1. Admin invites; 2. invitee accepts with the raw token.
    const token = await inviteToAlpha()
    const accept = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token, userId: 'erin', role: 'member' })
    expect(accept.status).toBe(200)
    expect(accept.body).toMatchObject({ orgId: ORG_ALPHA, userId: 'erin', role: 'member' })

    // 3. The new member is recorded with the expected role…
    expect(getMemberRole(ORG_ALPHA, 'erin')).toBe('member')

    // 4. …and can now read that org's scoped resource (its member roster),
    //    seeing itself listed with the expected role.
    const roster = await readRoster(ORG_ALPHA, 'erin')
    expect(roster.status).toBe(200)
    expect(roster.body.members.find((m: any) => m.user_id === 'erin')).toMatchObject({
      organization_id: ORG_ALPHA,
      role: 'member',
    })
  })

  it('confines the newly accepted member to their org (cross-tenant isolation)', async () => {
    const token = await inviteToAlpha()
    await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token, userId: 'erin', role: 'member' })
      .expect(200)

    // Accepted into Alpha only — Beta's roster must stay off-limits.
    const crossOrg = await readRoster(ORG_BETA, 'erin')
    expect(crossOrg.status).toBe(403)
    expect(crossOrg.body.error).toMatch(/not a member/i)
  })

  it('honours the role requested at acceptance time', async () => {
    const token = await inviteToAlpha()
    const accept = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token, userId: 'frank', role: 'admin' })
    expect(accept.status).toBe(200)
    expect(accept.body.role).toBe('admin')
    expect(getMemberRole(ORG_ALPHA, 'frank')).toBe('admin')
  })

  it('rejects re-accepting an already-used token and does not duplicate membership', async () => {
    const token = await inviteToAlpha()
    await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token, userId: 'erin', role: 'member' })
      .expect(200)

    const replay = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token, userId: 'erin', role: 'member' })
    expect(replay.status).toBe(400)
    expect(replay.body.error.message).toMatch(/invalid or expired/i)
    expect(getOrgMembers(ORG_ALPHA).filter((m) => m.userId === 'erin')).toHaveLength(1)
  })

  it('rejects an expired invitation token at acceptance', async () => {
    const rawToken = crypto.randomBytes(32).toString('hex')
    invitations.push({
      id: crypto.randomUUID(),
      org_id: ORG_ALPHA,
      email: 'late@example.com',
      token_hash: sha256(rawToken),
      expires_at: new Date(Date.now() - 1000), // already expired
      accepted_at: null,
      revoked_at: null,
    })

    const res = await request(app)
      .post(`/api/organizations/${ORG_ALPHA}/invitations/accept`)
      .send({ token: rawToken, userId: 'erin', role: 'member' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/invalid or expired/i)
    expect(getMemberRole(ORG_ALPHA, 'erin')).toBeUndefined()
  })
})
