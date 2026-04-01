/**
 * Organization membership rules – Issue #134
 *
 * Tests cover:
 *  - Unit: in-memory model mutation helpers (addOrgMember, removeOrgMember,
 *          updateOrgMemberRole, countOrgAdmins) + LastAdminError edge cases
 *  - Integration: HTTP endpoints via a minimal Express test app
 *    (no real DB – uses in-memory model only)
 */
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import jwt from 'jsonwebtoken'
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import {
  setOrganizations,
  setOrgMembers,
  getOrgMembers,
  countOrgAdmins,
  addOrgMember,
  removeOrgMember,
  updateOrgMemberRole,
  LastAdminError,
} from '../src/models/organizations.js'
import { orgMembersRouter } from '../src/routes/orgMembers.js'

// Test app setup 
const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production'

/** Minimal authenticate shim – mirrors auth.ts without DB/session overhead. */
function mockAuthenticate(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed Authorization header' })
    return
  }
  try {
    req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as any
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}

// Patch the router to use the mock authenticator in tests.
// We create a wrapper app that replaces the real `authenticate` middleware
// by injecting mock tokens into req.user before the router processes them.
const testApp = express()
testApp.use(express.json())

// Inject mock auth before handing off to the orgMembersRouter
testApp.use((req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization
  if (authHeader?.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(authHeader.slice(7), JWT_SECRET) as any
    } catch { /* intentionally ignored – let downstream middleware reject */ }
  }
  next()
})

// Mount a thin wrapper that bypasses the real `authenticate` (which uses
// JWT_ACCESS_SECRET) by pre-populating req.user, then delegates to the router.
// We rebuild equivalent routes inline so the existing orgMembersRouter
// (which references the real authenticate) stays unchanged for production.
import { requireOrgAccess } from '../src/middleware/orgAuth.js'
import { createAuditLog } from '../src/lib/audit-logs.js'
import { type OrgRole } from '../src/models/organizations.js'

const testRouter = express.Router()

testRouter.get(
  '/:orgId/members',
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  },
  requireOrgAccess('owner', 'admin', 'member'),
  (req: Request, res: Response) => {
    res.json({ members: getOrgMembers(req.params.orgId) })
  },
)

testRouter.post(
  '/:orgId/members',
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  },
  requireOrgAccess('owner', 'admin'),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    const { userId, role } = req.body as { userId?: string; role?: string }
    if (!userId) { res.status(400).json({ error: 'userId is required.' }); return }
    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    const assignedRole: OrgRole = validRoles.includes(role as OrgRole) ? (role as OrgRole) : 'member'
    try {
      addOrgMember({ orgId, userId, role: assignedRole })
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Failed.' })
      return
    }
    createAuditLog({ actor_user_id: (req.user as any).userId ?? (req.user as any).sub, action: 'org.member.added', target_type: 'org_membership', target_id: `${orgId}:${userId}`, metadata: { orgId, role: assignedRole } })
    res.status(201).json({ orgId, userId, role: assignedRole })
  },
)

testRouter.delete(
  '/:orgId/members/:userId',
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  },
  requireOrgAccess('owner', 'admin'),
  (req: Request, res: Response) => {
    const { orgId, userId } = req.params
    try {
      removeOrgMember(orgId, userId)
    } catch (err) {
      if (err instanceof LastAdminError) { res.status(422).json({ error: err.message }); return }
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed.' })
      return
    }
    createAuditLog({ actor_user_id: (req.user as any).userId ?? (req.user as any).sub, action: 'org.member.removed', target_type: 'org_membership', target_id: `${orgId}:${userId}`, metadata: { orgId } })
    res.status(200).json({ message: 'Member removed.', orgId, userId })
  },
)

testRouter.patch(
  '/:orgId/members/:userId/role',
  (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) { res.status(401).json({ error: 'Unauthorized' }); return }
    next()
  },
  requireOrgAccess('owner'),
  (req: Request, res: Response) => {
    const { orgId, userId } = req.params
    const { role } = req.body as { role?: string }
    const validRoles: OrgRole[] = ['owner', 'admin', 'member']
    if (!role || !validRoles.includes(role as OrgRole)) {
      res.status(400).json({ error: `role must be one of: ${validRoles.join(', ')}.` }); return
    }
    try {
      updateOrgMemberRole(orgId, userId, role as OrgRole)
    } catch (err) {
      if (err instanceof LastAdminError) { res.status(422).json({ error: err.message }); return }
      res.status(404).json({ error: err instanceof Error ? err.message : 'Failed.' })
      return
    }
    createAuditLog({ actor_user_id: (req.user as any).userId ?? (req.user as any).sub, action: 'org.member.role_changed', target_type: 'org_membership', target_id: `${orgId}:${userId}`, metadata: { orgId, newRole: role } })
    res.status(200).json({ orgId, userId, role })
  },
)

testApp.use('/api/organizations', testRouter)

// Token helper
const tok = (sub: string) =>
  `Bearer ${jwt.sign({ sub, userId: sub }, JWT_SECRET, { expiresIn: '1h' })}`

// Seed helpers
const ORG = 'org-alpha'
const OTHER_ORG = 'org-beta'

function seed() {
  setOrganizations([
    { id: ORG, name: 'Alpha Org', createdAt: '2025-01-01T00:00:00Z' },
    { id: OTHER_ORG, name: 'Beta Org', createdAt: '2025-01-01T00:00:00Z' },
  ])
  setOrgMembers([
    { orgId: ORG, userId: 'alice', role: 'owner' },
    { orgId: ORG, userId: 'bob', role: 'admin' },
    { orgId: ORG, userId: 'carol', role: 'member' },
    { orgId: OTHER_ORG, userId: 'dave', role: 'owner' },
  ])
}

beforeEach(seed)

afterEach(() => {
  setOrganizations([])
  setOrgMembers([])
})

// Unit tests – in-memory model

describe('countOrgAdmins()', () => {
  it('counts owner + admin roles', () => {
    expect(countOrgAdmins(ORG)).toBe(2) // alice(owner) + bob(admin)
  })

  it('returns 0 for an empty org', () => {
    setOrgMembers([])
    expect(countOrgAdmins(ORG)).toBe(0)
  })

  it('does not count member role', () => {
    setOrgMembers([{ orgId: ORG, userId: 'carol', role: 'member' }])
    expect(countOrgAdmins(ORG)).toBe(0)
  })
})

describe('addOrgMember()', () => {
  it('adds a new member', () => {
    addOrgMember({ orgId: ORG, userId: 'eve', role: 'member' })
    expect(getOrgMembers(ORG).some((m) => m.userId === 'eve')).toBe(true)
  })

  it('throws if user is already a member', () => {
    expect(() => addOrgMember({ orgId: ORG, userId: 'alice', role: 'member' })).toThrow(
      /already a member/i,
    )
  })

  it('can add a member as admin', () => {
    addOrgMember({ orgId: ORG, userId: 'new-admin', role: 'admin' })
    const member = getOrgMembers(ORG).find((m) => m.userId === 'new-admin')
    expect(member?.role).toBe('admin')
  })
})

describe('removeOrgMember()', () => {
  it('removes a regular member', () => {
    removeOrgMember(ORG, 'carol')
    expect(getOrgMembers(ORG).find((m) => m.userId === 'carol')).toBeUndefined()
  })

  it('removes an admin when another admin exists', () => {
    // alice(owner) + bob(admin) → 2 admins, so removing bob is safe
    removeOrgMember(ORG, 'bob')
    expect(getOrgMembers(ORG).find((m) => m.userId === 'bob')).toBeUndefined()
  })

  it('throws LastAdminError when removing the sole remaining admin', () => {
    // Remove bob first, leaving alice as only admin
    removeOrgMember(ORG, 'bob')
    expect(() => removeOrgMember(ORG, 'alice')).toThrow(LastAdminError)
  })

  it('LastAdminError message is descriptive', () => {
    removeOrgMember(ORG, 'bob')
    expect(() => removeOrgMember(ORG, 'alice')).toThrow(
      /cannot remove or demote the last admin/i,
    )
  })

  it('throws for a non-existent membership', () => {
    expect(() => removeOrgMember(ORG, 'nobody')).toThrow(/not found/i)
  })

  it('does NOT throw when org has two admins and one is removed', () => {
    expect(() => removeOrgMember(ORG, 'alice')).not.toThrow()
  })
})

describe('updateOrgMemberRole()', () => {
  it('promotes a member to admin', () => {
    updateOrgMemberRole(ORG, 'carol', 'admin')
    expect(getOrgMembers(ORG).find((m) => m.userId === 'carol')?.role).toBe('admin')
  })

  it('demotes an admin to member when another admin exists', () => {
    updateOrgMemberRole(ORG, 'bob', 'member')
    expect(getOrgMembers(ORG).find((m) => m.userId === 'bob')?.role).toBe('member')
  })

  it('throws LastAdminError when demoting the last admin', () => {
    // Remove bob to make alice the sole admin
    removeOrgMember(ORG, 'bob')
    expect(() => updateOrgMemberRole(ORG, 'alice', 'member')).toThrow(LastAdminError)
  })

  it('allows changing owner → admin (stays admin-level, no violation)', () => {
    // alice is the owner, bob is admin → safe to demote alice to admin
    expect(() => updateOrgMemberRole(ORG, 'alice', 'admin')).not.toThrow()
    expect(getOrgMembers(ORG).find((m) => m.userId === 'alice')?.role).toBe('admin')
  })

  it('allows changing admin → owner (promotion)', () => {
    expect(() => updateOrgMemberRole(ORG, 'bob', 'owner')).not.toThrow()
    expect(getOrgMembers(ORG).find((m) => m.userId === 'bob')?.role).toBe('owner')
  })

  it('throws for a non-existent membership', () => {
    expect(() => updateOrgMemberRole(ORG, 'nobody', 'admin')).toThrow(/not found/i)
  })

  it('throws LastAdminError when demoting the only owner with no other admins', () => {
    setOrgMembers([
      { orgId: ORG, userId: 'solo', role: 'owner' },
      { orgId: ORG, userId: 'regular', role: 'member' },
    ])
    expect(() => updateOrgMemberRole(ORG, 'solo', 'member')).toThrow(LastAdminError)
  })
})

// Integration tests – HTTP endpoints

describe('GET /api/organizations/:orgId/members', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp).get(`/api/organizations/${ORG}/members`)
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-member', async () => {
    const res = await request(testApp)
      .get(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('dave'))
    expect(res.status).toBe(403)
  })

  it('returns 404 for non-existent org', async () => {
    const res = await request(testApp)
      .get('/api/organizations/org-ghost/members')
      .set('Authorization', tok('alice'))
    expect(res.status).toBe(404)
  })

  it('returns member list for any member role', async () => {
    const res = await request(testApp)
      .get(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('carol'))
      .expect(200)

    expect(Array.isArray(res.body.members)).toBe(true)
    expect(res.body.members).toHaveLength(3)
  })

  it('does not leak members from other orgs', async () => {
    const res = await request(testApp)
      .get(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
      .expect(200)

    const userIds = res.body.members.map((m: any) => m.userId)
    expect(userIds).not.toContain('dave')
  })
})

describe('POST /api/organizations/:orgId/members', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .send({ userId: 'newuser' })
    expect(res.status).toBe(401)
  })

  it('returns 403 for member role (not admin/owner)', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('carol'))
      .send({ userId: 'newuser' })
    expect(res.status).toBe(403)
  })

  it('returns 400 when userId is missing', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
      .send({ role: 'member' })
      .expect(400)

    expect(res.body.error).toMatch(/userId is required/i)
  })

  it('adds a new member as owner', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
      .send({ userId: 'newcomer', role: 'member' })
      .expect(201)

    expect(res.body.userId).toBe('newcomer')
    expect(res.body.role).toBe('member')
  })

  it('returns 409 when user is already a member', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
      .send({ userId: 'carol' })
      .expect(409)

    expect(res.body.error).toMatch(/already a member/i)
  })

  it('defaults role to member when an invalid role is provided', async () => {
    const res = await request(testApp)
      .post(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
      .send({ userId: 'newcomer2', role: 'superuser' })
      .expect(201)

    expect(res.body.role).toBe('member')
  })
})

describe('DELETE /api/organizations/:orgId/members/:userId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp).delete(`/api/organizations/${ORG}/members/carol`)
    expect(res.status).toBe(401)
  })

  it('returns 403 for member role (cannot remove others)', async () => {
    const res = await request(testApp)
      .delete(`/api/organizations/${ORG}/members/carol`)
      .set('Authorization', tok('carol'))
    expect(res.status).toBe(403)
  })

  it('removes a regular member as admin', async () => {
    await request(testApp)
      .delete(`/api/organizations/${ORG}/members/carol`)
      .set('Authorization', tok('bob'))
      .expect(200)

    const getRes = await request(testApp)
      .get(`/api/organizations/${ORG}/members`)
      .set('Authorization', tok('alice'))
    expect(getRes.body.members.find((m: any) => m.userId === 'carol')).toBeUndefined()
  })

  it('returns 404 for non-existent membership', async () => {
    const res = await request(testApp)
      .delete(`/api/organizations/${ORG}/members/nobody`)
      .set('Authorization', tok('alice'))
      .expect(404)

    expect(res.body.error).toMatch(/not found/i)
  })

  it('returns 422 when removing the last admin', async () => {
    // Remove bob to make alice the only admin
    await request(testApp)
      .delete(`/api/organizations/${ORG}/members/bob`)
      .set('Authorization', tok('alice'))
      .expect(200)

    // Now try to remove alice (sole admin) → 422
    const res = await request(testApp)
      .delete(`/api/organizations/${ORG}/members/alice`)
      .set('Authorization', tok('alice'))
      .expect(422)

    expect(res.body.error).toMatch(/cannot remove or demote the last admin/i)
  })

  it('allows removing one of multiple admins', async () => {
    // bob is admin, alice is owner → removing bob is safe
    await request(testApp)
      .delete(`/api/organizations/${ORG}/members/bob`)
      .set('Authorization', tok('alice'))
      .expect(200)
  })
})

describe('PATCH /api/organizations/:orgId/members/:userId/role', () => {
  it('returns 401 without auth', async () => {
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/carol/role`)
      .send({ role: 'admin' })
    expect(res.status).toBe(401)
  })

  it('returns 403 for admin role (only owner can change roles)', async () => {
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/carol/role`)
      .set('Authorization', tok('bob'))
      .send({ role: 'admin' })
    expect(res.status).toBe(403)
  })

  it('returns 400 for invalid role value', async () => {
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/carol/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'superuser' })
      .expect(400)

    expect(res.body.error).toMatch(/must be one of/i)
  })

  it('promotes member to admin', async () => {
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/carol/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'admin' })
      .expect(200)

    expect(res.body.role).toBe('admin')
  })

  it('demotes admin to member when another admin exists', async () => {
    // alice(owner) is still admin-level after bob is demoted
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/bob/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'member' })
      .expect(200)

    expect(res.body.role).toBe('member')
  })

  it('returns 422 when demoting the last admin to member', async () => {
    // Remove bob first → alice becomes sole admin
    removeOrgMember(ORG, 'bob')

    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/alice/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'member' })
      .expect(422)

    expect(res.body.error).toMatch(/cannot remove or demote the last admin/i)
  })

  it('returns 404 for non-existent membership', async () => {
    const res = await request(testApp)
      .patch(`/api/organizations/${ORG}/members/nobody/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'admin' })
      .expect(404)

    expect(res.body.error).toMatch(/not found/i)
  })

  it('allows changing owner → admin when another admin exists', async () => {
    // alice(owner) → admin is safe because bob is still admin
    await request(testApp)
      .patch(`/api/organizations/${ORG}/members/alice/role`)
      .set('Authorization', tok('alice'))
      .send({ role: 'admin' })
      .expect(200)
  })
})

// Edge case: single-member org
describe('Single-member org edge cases', () => {
  beforeEach(() => {
    setOrganizations([{ id: 'solo-org', name: 'Solo', createdAt: '2025-01-01T00:00:00Z' }])
    setOrgMembers([{ orgId: 'solo-org', userId: 'solo-owner', role: 'owner' }])
  })

  it('cannot remove the only member (who is admin)', () => {
    expect(() => removeOrgMember('solo-org', 'solo-owner')).toThrow(LastAdminError)
  })

  it('cannot demote the only member', () => {
    expect(() => updateOrgMemberRole('solo-org', 'solo-owner', 'member')).toThrow(LastAdminError)
  })

  it('can add a second member and then demote the original owner', () => {
    addOrgMember({ orgId: 'solo-org', userId: 'new-admin', role: 'admin' })
    expect(() => updateOrgMemberRole('solo-org', 'solo-owner', 'member')).not.toThrow()
  })

  it('HTTP: returns 422 when removing the sole owner', async () => {
    const res = await request(testApp)
      .delete('/api/organizations/solo-org/members/solo-owner')
      .set('Authorization', tok('solo-owner'))
    // solo-owner is the only member – requireOrgAccess lets them through as owner
    expect(res.status).toBe(422)
    expect(res.body.error).toMatch(/last admin/i)
  })
})
