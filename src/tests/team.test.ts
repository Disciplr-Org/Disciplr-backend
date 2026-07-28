import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { Knex } from 'knex'
import {
  setupTestDatabase,
  teardownTestDatabase,
} from './helpers/testDatabase.js'
import { createTeam, getTeamById, listTeamsByOrganization } from '../services/team.js'
import type { CreateTeamInput } from '../types/enterprise.js'

describe('Team Service - Tenant Isolation & Membership Resolution', () => {
  let db: Knex

  beforeAll(async () => {
    db = await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    // Clean tables in correct order (respecting foreign keys)
    await db('memberships').delete()
    await db('teams').delete()
    await db('organizations').delete()
  })

  describe('Tenant Isolation - Cross-Org Team Read/Write Protection', () => {
    it('should create team within correct organization boundary', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org Alpha',
          slug: 'org-alpha',
          metadata: JSON.stringify({ tier: 'enterprise' }),
        })
        .returning('*')

      const [org2] = await db('organizations')
        .insert({
          name: 'Org Beta',
          slug: 'org-beta',
          metadata: JSON.stringify({ tier: 'startup' }),
        })
        .returning('*')

      const teamInput: CreateTeamInput = {
        name: 'Engineering',
        slug: 'engineering',
        organization_id: org1.id,
        metadata: { department: 'tech' },
      }

      const team = await createTeam(teamInput)

      expect(team.organization_id).toBe(org1.id)
      expect(team.organization_id).not.toBe(org2.id)
      expect(team.name).toBe('Engineering')
      expect(team.slug).toBe('engineering')
    })

    it('should ONLY return teams from specified org', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org Alpha',
          slug: 'org-alpha',
        })
        .returning('*')

      const [org2] = await db('organizations')
        .insert({
          name: 'Org Beta',
          slug: 'org-beta',
        })
        .returning('*')

      // Create teams for Org 1
      await createTeam({
        name: 'Team A1',
        slug: 'team-a1',
        organization_id: org1.id,
      })
      await createTeam({
        name: 'Team A2',
        slug: 'team-a2',
        organization_id: org1.id,
      })

      // Create teams for Org 2
      await createTeam({
        name: 'Team B1',
        slug: 'team-b1',
        organization_id: org2.id,
      })
      await createTeam({
        name: 'Team B2',
        slug: 'team-b2',
        organization_id: org2.id,
      })

      const org1Teams = await listTeamsByOrganization(org1.id)
      const org2Teams = await listTeamsByOrganization(org2.id)

      // Assert Org 1 sees only its teams
      expect(org1Teams).toHaveLength(2)
      expect(org1Teams.every((t) => t.organization_id === org1.id)).toBe(true)
      expect(org1Teams.map((t) => t.name)).toEqual(
        expect.arrayContaining(['Team A1', 'Team A2'])
      )

      // Assert Org 2 sees only its teams
      expect(org2Teams).toHaveLength(2)
      expect(org2Teams.every((t) => t.organization_id === org2.id)).toBe(true)
      expect(org2Teams.map((t) => t.name)).toEqual(
        expect.arrayContaining(['Team B1', 'Team B2'])
      )

      // Assert no cross-org leakage
      const org1TeamNames = org1Teams.map((t) => t.name)
      const org2TeamNames = org2Teams.map((t) => t.name)
      expect(org1TeamNames).not.toContain('Team B1')
      expect(org1TeamNames).not.toContain('Team B2')
      expect(org2TeamNames).not.toContain('Team A1')
      expect(org2TeamNames).not.toContain('Team A2')
    })

    it('should return team regardless of org (no implicit filtering)', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org Alpha',
          slug: 'org-alpha',
        })
        .returning('*')

      const team = await createTeam({
        name: 'Isolated Team',
        slug: 'isolated-team',
        organization_id: org1.id,
      })

      const fetchedTeam = await getTeamById(team.id)

      expect(fetchedTeam).not.toBeNull()
      expect(fetchedTeam?.id).toBe(team.id)
      expect(fetchedTeam?.organization_id).toBe(org1.id)
      expect(fetchedTeam?.name).toBe('Isolated Team')
    })

    it('CRITICAL: getTeamById from Org A must NOT accidentally return Org B team', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org Alpha',
          slug: 'org-alpha',
        })
        .returning('*')

      const [org2] = await db('organizations')
        .insert({
          name: 'Org Beta',
          slug: 'org-beta',
        })
        .returning('*')

      const org1Team = await createTeam({
        name: 'Org 1 Team',
        slug: 'org1-team',
        organization_id: org1.id,
      })

      const org2Team = await createTeam({
        name: 'Org 2 Team',
        slug: 'org2-team',
        organization_id: org2.id,
      })

      // Fetch both teams by ID
      const fetchedOrg1Team = await getTeamById(org1Team.id)
      const fetchedOrg2Team = await getTeamById(org2Team.id)

      // Assert teams are correctly isolated
      expect(fetchedOrg1Team?.organization_id).toBe(org1.id)
      expect(fetchedOrg1Team?.organization_id).not.toBe(org2.id)

      expect(fetchedOrg2Team?.organization_id).toBe(org2.id)
      expect(fetchedOrg2Team?.organization_id).not.toBe(org1.id)

      // Assert no ID collision
      expect(fetchedOrg1Team?.id).not.toBe(fetchedOrg2Team?.id)
    })

    it('should return empty array for org with no teams', async () => {
      const [emptyOrg] = await db('organizations')
        .insert({
          name: 'Empty Org',
          slug: 'empty-org',
        })
        .returning('*')

      const teams = await listTeamsByOrganization(emptyOrg.id)

      expect(teams).toEqual([])
      expect(teams).toHaveLength(0)
    })

    it('should return empty array for non-existent org', async () => {
      const fakeOrgId = '00000000-0000-0000-0000-000000000000'
      const teams = await listTeamsByOrganization(fakeOrgId)

      expect(teams).toEqual([])
      expect(teams).toHaveLength(0)
    })
  })

  describe('Membership Resolution - Multi-Team User Scenarios', () => {
    it('user can be member of multiple teams in same organization', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Multi-Team Org',
          slug: 'multi-team-org',
        })
        .returning('*')

      const team1 = await createTeam({
        name: 'Engineering',
        slug: 'engineering',
        organization_id: org.id,
      })

      const team2 = await createTeam({
        name: 'Product',
        slug: 'product',
        organization_id: org.id,
      })

      const userId = 'user-123'

      // Add user to both teams
      await db('memberships').insert([
        {
          user_id: userId,
          organization_id: org.id,
          team_id: team1.id,
          role: 'member',
        },
        {
          user_id: userId,
          organization_id: org.id,
          team_id: team2.id,
          role: 'admin',
        },
      ])

      // Verify user is in both teams
      const memberships = await db('memberships')
        .where({ user_id: userId, organization_id: org.id })
        .select('*')

      expect(memberships).toHaveLength(2)
      expect(memberships.map((m) => m.team_id)).toEqual(
        expect.arrayContaining([team1.id, team2.id])
      )

      // Verify teams still exist and are correct
      const teams = await listTeamsByOrganization(org.id)
      expect(teams).toHaveLength(2)
    })

    it('user can have different roles in different teams', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Role Test Org',
          slug: 'role-test-org',
        })
        .returning('*')

      const team1 = await createTeam({
        name: 'Team Alpha',
        slug: 'team-alpha',
        organization_id: org.id,
      })

      const team2 = await createTeam({
        name: 'Team Beta',
        slug: 'team-beta',
        organization_id: org.id,
      })

      const userId = 'user-456'

      await db('memberships').insert([
        {
          user_id: userId,
          organization_id: org.id,
          team_id: team1.id,
          role: 'admin',
        },
        {
          user_id: userId,
          organization_id: org.id,
          team_id: team2.id,
          role: 'viewer',
        },
      ])

      const memberships = await db('memberships')
        .where({ user_id: userId })
        .select('*')

      const team1Membership = memberships.find((m) => m.team_id === team1.id)
      const team2Membership = memberships.find((m) => m.team_id === team2.id)

      expect(team1Membership?.role).toBe('admin')
      expect(team2Membership?.role).toBe('viewer')
    })

    it('multiple users can be members of same team', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Shared Team Org',
          slug: 'shared-team-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'Shared Team',
        slug: 'shared-team',
        organization_id: org.id,
      })

      const user1 = 'user-111'
      const user2 = 'user-222'
      const user3 = 'user-333'

      await db('memberships').insert([
        {
          user_id: user1,
          organization_id: org.id,
          team_id: team.id,
          role: 'member',
        },
        {
          user_id: user2,
          organization_id: org.id,
          team_id: team.id,
          role: 'member',
        },
        {
          user_id: user3,
          organization_id: org.id,
          team_id: team.id,
          role: 'admin',
        },
      ])

      const teamMembers = await db('memberships')
        .where({ team_id: team.id })
        .select('*')

      expect(teamMembers).toHaveLength(3)
      expect(teamMembers.map((m) => m.user_id)).toEqual(
        expect.arrayContaining([user1, user2, user3])
      )
    })

    it('CRITICAL: user membership in Org A team should NOT leak into Org B', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org Alpha',
          slug: 'org-alpha',
        })
        .returning('*')

      const [org2] = await db('organizations')
        .insert({
          name: 'Org Beta',
          slug: 'org-beta',
        })
        .returning('*')

      const team1 = await createTeam({
        name: 'Team A',
        slug: 'team-a',
        organization_id: org1.id,
      })

      const team2 = await createTeam({
        name: 'Team B',
        slug: 'team-b',
        organization_id: org2.id,
      })

      const userId = 'user-cross-org'

      // User is member of both orgs, different teams
      await db('memberships').insert([
        {
          user_id: userId,
          organization_id: org1.id,
          team_id: team1.id,
          role: 'admin',
        },
        {
          user_id: userId,
          organization_id: org2.id,
          team_id: team2.id,
          role: 'member',
        },
      ])

      // Query memberships by org
      const org1Memberships = await db('memberships')
        .where({
          user_id: userId,
          organization_id: org1.id,
        })
        .select('*')

      const org2Memberships = await db('memberships')
        .where({
          user_id: userId,
          organization_id: org2.id,
        })
        .select('*')

      // Assert strict isolation
      expect(org1Memberships).toHaveLength(1)
      expect(org1Memberships[0].team_id).toBe(team1.id)
      expect(org1Memberships[0].organization_id).toBe(org1.id)

      expect(org2Memberships).toHaveLength(1)
      expect(org2Memberships[0].team_id).toBe(team2.id)
      expect(org2Memberships[0].organization_id).toBe(org2.id)

      // Assert no cross-org data
      expect(org1Memberships[0].team_id).not.toBe(team2.id)
      expect(org2Memberships[0].team_id).not.toBe(team1.id)
    })
  })

  describe('Edge Cases - Empty Orgs & Deleted Teams', () => {
    it('team creation in empty org should succeed', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Brand New Org',
          slug: 'brand-new-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'First Team',
        slug: 'first-team',
        organization_id: org.id,
      })

      expect(team).toBeDefined()
      expect(team.organization_id).toBe(org.id)

      const teams = await listTeamsByOrganization(org.id)
      expect(teams).toHaveLength(1)
      expect(teams[0].id).toBe(team.id)
    })

    it('deleting team should cascade delete memberships', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Cascade Org',
          slug: 'cascade-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'To Delete Team',
        slug: 'to-delete-team',
        organization_id: org.id,
      })

      const userId = 'user-cascade'
      await db('memberships').insert({
        user_id: userId,
        organization_id: org.id,
        team_id: team.id,
        role: 'member',
      })

      // Verify membership exists
      const membershipsBefore = await db('memberships')
        .where({ team_id: team.id })
        .select('*')
      expect(membershipsBefore).toHaveLength(1)

      // Delete team (CASCADE should delete memberships)
      await db('teams').where({ id: team.id }).delete()

      // Verify team is deleted
      const deletedTeam = await getTeamById(team.id)
      expect(deletedTeam).toBeNull()

      // Verify memberships are cascade deleted
      const membershipsAfter = await db('memberships')
        .where({ team_id: team.id })
        .select('*')
      expect(membershipsAfter).toHaveLength(0)
    })

    it('deleting organization should cascade delete teams and memberships', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'To Delete Org',
          slug: 'to-delete-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'Team In Org',
        slug: 'team-in-org',
        organization_id: org.id,
      })

      await db('memberships').insert({
        user_id: 'user-orphan',
        organization_id: org.id,
        team_id: team.id,
        role: 'member',
      })

      // Delete organization
      await db('organizations').where({ id: org.id }).delete()

      // Verify cascade deletion
      const teams = await listTeamsByOrganization(org.id)
      expect(teams).toHaveLength(0)

      const memberships = await db('memberships')
        .where({ organization_id: org.id })
        .select('*')
      expect(memberships).toHaveLength(0)
    })

    it('getTeamById should return null for non-existent team', async () => {
      const fakeTeamId = '00000000-0000-0000-0000-000000000000'
      const team = await getTeamById(fakeTeamId)

      expect(team).toBeNull()
    })

    it('team with null metadata should be created successfully', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Metadata Test Org',
          slug: 'metadata-test-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'No Metadata Team',
        slug: 'no-metadata-team',
        organization_id: org.id,
      })

      expect(team.metadata).toBeNull()

      const fetchedTeam = await getTeamById(team.id)
      expect(fetchedTeam?.metadata).toBeNull()
    })

    it('unique constraint on organization_id + slug should prevent duplicates', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Unique Test Org',
          slug: 'unique-test-org',
        })
        .returning('*')

      await createTeam({
        name: 'Original Team',
        slug: 'duplicate-slug',
        organization_id: org.id,
      })

      // Attempt to create duplicate slug in same org
      await expect(
        createTeam({
          name: 'Duplicate Team',
          slug: 'duplicate-slug',
          organization_id: org.id,
        })
      ).rejects.toThrow()
    })

    it('same slug in different orgs should be allowed', async () => {
      const [org1] = await db('organizations')
        .insert({
          name: 'Org 1',
          slug: 'org-1',
        })
        .returning('*')

      const [org2] = await db('organizations')
        .insert({
          name: 'Org 2',
          slug: 'org-2',
        })
        .returning('*')

      const team1 = await createTeam({
        name: 'Engineering',
        slug: 'engineering',
        organization_id: org1.id,
      })

      const team2 = await createTeam({
        name: 'Engineering',
        slug: 'engineering',
        organization_id: org2.id,
      })

      expect(team1.slug).toBe('engineering')
      expect(team2.slug).toBe('engineering')
      expect(team1.id).not.toBe(team2.id)
      expect(team1.organization_id).not.toBe(team2.organization_id)
    })
  })

  describe('Data Integrity & Schema Validation', () => {
    it('team must have valid organization_id (foreign key constraint)', async () => {
      const fakeOrgId = '00000000-0000-0000-0000-000000000000'

      await expect(
        createTeam({
          name: 'Orphan Team',
          slug: 'orphan-team',
          organization_id: fakeOrgId,
        })
      ).rejects.toThrow()
    })

    it('team fields are correctly returned with proper types', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Type Check Org',
          slug: 'type-check-org',
        })
        .returning('*')

      const team = await createTeam({
        name: 'Type Team',
        slug: 'type-team',
        organization_id: org.id,
        metadata: { key: 'value' },
      })

      expect(typeof team.id).toBe('string')
      expect(typeof team.name).toBe('string')
      expect(typeof team.slug).toBe('string')
      expect(typeof team.organization_id).toBe('string')
      expect(team.created_at).toBeInstanceOf(Date)
      expect(team.updated_at).toBeInstanceOf(Date)
      expect(typeof team.metadata).toBe('string') // JSON stored as string
    })

    it('team creation timestamps should be set automatically', async () => {
      const [org] = await db('organizations')
        .insert({
          name: 'Timestamp Org',
          slug: 'timestamp-org',
        })
        .returning('*')

      const beforeCreation = new Date()

      const team = await createTeam({
        name: 'Timestamp Team',
        slug: 'timestamp-team',
        organization_id: org.id,
      })

      const afterCreation = new Date()

      expect(team.created_at).toBeDefined()
      expect(team.updated_at).toBeDefined()
      expect(new Date(team.created_at!).getTime()).toBeGreaterThanOrEqual(
        beforeCreation.getTime()
      )
      expect(new Date(team.created_at!).getTime()).toBeLessThanOrEqual(
        afterCreation.getTime()
      )
    })
  })
})
