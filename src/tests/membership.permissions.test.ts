import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from '@jest/globals'
import type { Knex } from 'knex'
import {
  setupTestDatabase,
  teardownTestDatabase,
} from './helpers/testDatabase.js'

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
}))

const {
  resolveEffectiveOrgRole,
  getUserOrganizationRole,
  changeRole,
  removeMembership,
  createMembership,
  pickHigherOrgRole,
  getOrgRoleRank,
  isKnownOrgRole,
  LastAdminError,
} = await import('../services/membership.js')

describe('Membership permission resolution edge cases', () => {
  let db: Knex

  beforeAll(async () => {
    db = await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    await db('memberships').delete()
    await db('teams').delete()
    await db('organizations').delete()
  })

  async function createOrg(name: string, slug: string) {
    const [org] = await db('organizations')
      .insert({ name, slug })
      .returning('*')
    return org
  }

  async function createTeam(orgId: string, name: string, slug: string) {
    const [team] = await db('teams')
      .insert({ name, slug, organization_id: orgId })
      .returning('*')
    return team
  }

  async function seedOrgMembership(
    orgId: string,
    userId: string,
    role: string,
    teamId: string | null = null,
  ) {
    await db('memberships').insert({
      user_id: userId,
      organization_id: orgId,
      team_id: teamId,
      role,
    })
  }

  describe('Last owner protection', () => {
    it('rejects demoting the last owner via changeRole', async () => {
      const org = await createOrg('Solo Org', 'solo-org')
      const ownerId = 'owner-solo'
      await seedOrgMembership(org.id, ownerId, 'owner')

      await expect(
        changeRole(ownerId, org.id, 'admin', 'actor-1'),
      ).rejects.toThrow('Cannot demote the last owner of an organization.')
    })

    it('rejects removing the last owner via removeMembership', async () => {
      const org = await createOrg('Orphan Org', 'orphan-org')
      const ownerId = 'owner-only'
      await seedOrgMembership(org.id, ownerId, 'owner')

      await expect(removeMembership(ownerId, org.id)).rejects.toThrow(
        'Cannot remove the last owner of an organization.',
      )
    })

    it('allows demoting an owner when another owner exists', async () => {
      const org = await createOrg('Dual Owner Org', 'dual-owner-org')
      const ownerA = 'owner-a'
      const ownerB = 'owner-b'
      await seedOrgMembership(org.id, ownerA, 'owner')
      await seedOrgMembership(org.id, ownerB, 'owner')

      const updated = await changeRole(ownerA, org.id, 'admin', ownerB)

      expect(updated.role).toBe('admin')
      expect(await getUserOrganizationRole(ownerA, org.id)).toBe('admin')
      expect(await getUserOrganizationRole(ownerB, org.id)).toBe('owner')
    })

    it('rejects demoting the last admin via changeRole', async () => {
      const org = await createOrg('Single Admin Org', 'single-admin-org')
      const adminId = 'admin-only'
      await seedOrgMembership(org.id, adminId, 'admin')

      await expect(
        changeRole(adminId, org.id, 'member', 'actor-1'),
      ).rejects.toThrow(LastAdminError)
    })
  })

  describe('Conflicting role grants', () => {
    it('resolves to the highest role when org-level member and team-level admin exist', async () => {
      const org = await createOrg('Conflict Org', 'conflict-org')
      const team = await createTeam(org.id, 'Ops', 'ops')
      const userId = 'conflict-user'

      await seedOrgMembership(org.id, userId, 'member')
      await seedOrgMembership(org.id, userId, 'admin', team.id)

      expect(await resolveEffectiveOrgRole(userId, org.id)).toBe('admin')
      expect(await getUserOrganizationRole(userId, org.id)).toBe('member')
    })

    it('resolves owner over admin and member grants', async () => {
      const org = await createOrg('Layered Org', 'layered-org')
      const teamA = await createTeam(org.id, 'Team A', 'team-a')
      const teamB = await createTeam(org.id, 'Team B', 'team-b')
      const userId = 'layered-user'

      await seedOrgMembership(org.id, userId, 'member')
      await seedOrgMembership(org.id, userId, 'admin', teamA.id)
      await seedOrgMembership(org.id, userId, 'owner', teamB.id)

      expect(await resolveEffectiveOrgRole(userId, org.id)).toBe('owner')
    })

    it('pickHigherOrgRole prefers known roles over unknown roles', () => {
      expect(pickHigherOrgRole('custom-role', 'member')).toBe('member')
      expect(pickHigherOrgRole('custom-role', 'admin')).toBe('admin')
      expect(pickHigherOrgRole('custom-role', 'custom-role')).toBe('custom-role')
    })
  })

  describe('Multi-org isolation', () => {
    it('returns correct per-org permissions with no bleed', async () => {
      const orgA = await createOrg('Org Alpha', 'org-alpha')
      const orgB = await createOrg('Org Beta', 'org-beta')
      const teamA = await createTeam(orgA.id, 'Alpha Team', 'alpha-team')
      const teamB = await createTeam(orgB.id, 'Beta Team', 'beta-team')
      const userId = 'dual-org-user'

      await seedOrgMembership(orgA.id, userId, 'admin')
      await seedOrgMembership(orgA.id, userId, 'member', teamA.id)
      await seedOrgMembership(orgB.id, userId, 'member')
      await seedOrgMembership(orgB.id, userId, 'viewer', teamB.id)

      expect(await resolveEffectiveOrgRole(userId, orgA.id)).toBe('admin')
      expect(await resolveEffectiveOrgRole(userId, orgB.id)).toBe('member')
      expect(await getUserOrganizationRole(userId, orgA.id)).toBe('admin')
      expect(await getUserOrganizationRole(userId, orgB.id)).toBe('member')
    })
  })

  describe('Removed member access loss', () => {
    it('returns null immediately after removeMembership', async () => {
      const org = await createOrg('Removal Org', 'removal-org')
      const ownerId = 'owner-keep'
      const memberId = 'member-remove'
      await seedOrgMembership(org.id, ownerId, 'owner')
      await seedOrgMembership(org.id, memberId, 'member')

      expect(await resolveEffectiveOrgRole(memberId, org.id)).toBe('member')
      expect(await getUserOrganizationRole(memberId, org.id)).toBe('member')

      await removeMembership(memberId, org.id)

      expect(await resolveEffectiveOrgRole(memberId, org.id)).toBeNull()
      expect(await getUserOrganizationRole(memberId, org.id)).toBeNull()
    })
  })

  describe('Unknown role handling', () => {
    it('ranks unknown roles below all known roles', () => {
      expect(getOrgRoleRank('mystery')).toBe(-1)
      expect(getOrgRoleRank('member')).toBeGreaterThan(getOrgRoleRank('mystery'))
      expect(isKnownOrgRole('mystery')).toBe(false)
      expect(isKnownOrgRole('owner')).toBe(true)
    })

    it('returns unknown role when it is the only grant', async () => {
      const org = await createOrg('Unknown Role Org', 'unknown-role-org')
      const userId = 'unknown-role-user'
      await seedOrgMembership(org.id, userId, 'legacy-custom')

      expect(await resolveEffectiveOrgRole(userId, org.id)).toBe('legacy-custom')
      expect(isKnownOrgRole('legacy-custom')).toBe(false)
    })

    it('does not promote unknown roles above member grants', async () => {
      const org = await createOrg('Unknown Vs Member Org', 'unknown-vs-member-org')
      const userId = 'unknown-vs-member-user'
      await seedOrgMembership(org.id, userId, 'legacy-custom')
      await seedOrgMembership(org.id, userId, 'member')

      expect(await resolveEffectiveOrgRole(userId, org.id)).toBe('member')
    })
  })

  describe('createMembership baseline', () => {
    it('creates org-level membership with default member role', async () => {
      const org = await createOrg('Create Org', 'create-org')
      const userId = 'new-member'

      const membership = await createMembership({
        user_id: userId,
        organization_id: org.id,
      })

      expect(membership.role).toBe('member')
      expect(await resolveEffectiveOrgRole(userId, org.id)).toBe('member')
    })
  })
})
