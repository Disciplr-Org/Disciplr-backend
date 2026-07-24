import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import { Knex } from 'knex'
import {
  setupTestDatabase,
  teardownTestDatabase,
} from '../tests/helpers/testDatabase.js'
import {
  createOrganization,
  getOrganizationById,
  getOrganizationBySlug,
  listOrganizations,
} from './organization.js'
import type { CreateOrganizationInput } from '../types/enterprise.js'

describe('Organization Service — Lifecycle & Uniqueness Constraints', () => {
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

  describe('org creation', () => {
    it('should create an organization with valid input', async () => {
      const input: CreateOrganizationInput = {
        name: 'Test Organization',
        slug: 'test-org',
      }

      const org = await createOrganization(input)

      expect(org).toBeDefined()
      expect(org.id).toBeDefined()
      expect(typeof org.id).toBe('string')
      expect(org.name).toBe('Test Organization')
      expect(org.slug).toBe('test-org')
      expect(org.metadata).toBeNull()
      expect(org.created_at).toBeInstanceOf(Date)
      expect(org.updated_at).toBeInstanceOf(Date)
    })

    it('should create an organization with metadata', async () => {
      const metadata = { tier: 'enterprise', region: 'us-east-1' }
      const input: CreateOrganizationInput = {
        name: 'Meta Org',
        slug: 'meta-org',
        metadata,
      }

      const org = await createOrganization(input)

      expect(org).toBeDefined()
      expect(org.name).toBe('Meta Org')
      expect(org.slug).toBe('meta-org')
      // metadata is stored as JSONB and returned as parsed object by knex
      expect(org.metadata).toEqual(metadata)
    })

    it('should create an organization with null metadata when omitted', async () => {
      const input: CreateOrganizationInput = {
        name: 'No Metadata Org',
        slug: 'no-metadata-org',
      }

      const org = await createOrganization(input)

      expect(org.metadata).toBeNull()
    })

    it('should set created_at and updated_at timestamps automatically', async () => {
      const before = new Date()
      const input: CreateOrganizationInput = {
        name: 'Timestamp Org',
        slug: 'timestamp-org',
      }

      const org = await createOrganization(input)
      const after = new Date()

      expect(org.created_at!.getTime()).toBeGreaterThanOrEqual(before.getTime())
      expect(org.created_at!.getTime()).toBeLessThanOrEqual(after.getTime())
      expect(org.updated_at).toBeDefined()
    })

    it('should generate a UUID primary key', async () => {
      const input: CreateOrganizationInput = {
        name: 'UUID Org',
        slug: 'uuid-org',
      }

      const org = await createOrganization(input)

      expect(org.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      )
    })
  })

  describe('slug uniqueness', () => {
    it('should reject a duplicate slug (global unique constraint)', async () => {
      const input: CreateOrganizationInput = {
        name: 'First Org',
        slug: 'duplicate-slug',
      }

      await createOrganization(input)

      const duplicate: CreateOrganizationInput = {
        name: 'Second Org',
        slug: 'duplicate-slug',
      }

      await expect(createOrganization(duplicate)).rejects.toThrow()
    })

    it('should allow the same name with different slugs', async () => {
      const input1: CreateOrganizationInput = {
        name: 'Same Name Org',
        slug: 'first-slug',
      }

      const input2: CreateOrganizationInput = {
        name: 'Same Name Org',
        slug: 'second-slug',
      }

      const org1 = await createOrganization(input1)
      const org2 = await createOrganization(input2)

      expect(org1.id).not.toBe(org2.id)
      expect(org1.name).toBe(org2.name)
      expect(org1.slug).toBe('first-slug')
      expect(org2.slug).toBe('second-slug')
    })

    it('should allow the same slug after the original is deleted', async () => {
      const input: CreateOrganizationInput = {
        name: 'To Delete',
        slug: 'reusable-slug',
      }

      const org = await createOrganization(input)

      // Delete the org directly (no service function available)
      await db('organizations').where({ id: org.id }).delete()

      // Re-create with the same slug
      const recreated = await createOrganization({
        name: 'Recreated',
        slug: 'reusable-slug',
      })

      expect(recreated).toBeDefined()
      expect(recreated.slug).toBe('reusable-slug')
      expect(recreated.id).not.toBe(org.id)
    })
  })

  describe('getOrganizationById', () => {
    it('should return the organization by id', async () => {
      const input: CreateOrganizationInput = {
        name: 'Find Me',
        slug: 'find-me',
      }

      const created = await createOrganization(input)
      const found = await getOrganizationById(created.id)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe('Find Me')
      expect(found!.slug).toBe('find-me')
    })

    it('should return null for a non-existent id', async () => {
      const fakeId = '00000000-0000-0000-0000-000000000000'
      const result = await getOrganizationById(fakeId)

      expect(result).toBeNull()
    })
  })

  describe('getOrganizationBySlug', () => {
    it('should return the organization by slug', async () => {
      const input: CreateOrganizationInput = {
        name: 'Slug Lookup',
        slug: 'slug-lookup',
      }

      const created = await createOrganization(input)
      const found = await getOrganizationBySlug('slug-lookup')

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.name).toBe('Slug Lookup')
      expect(found!.slug).toBe('slug-lookup')
    })

    it('should return null for a non-existent slug', async () => {
      const result = await getOrganizationBySlug('non-existent-slug')
      expect(result).toBeNull()
    })
  })

  describe('listOrganizations', () => {
    it('should return all organizations', async () => {
      await createOrganization({ name: 'Org A', slug: 'org-a' })
      await createOrganization({ name: 'Org B', slug: 'org-b' })
      await createOrganization({ name: 'Org C', slug: 'org-c' })

      const orgs = await listOrganizations()

      expect(orgs).toHaveLength(3)
      expect(orgs.map((o) => o.name)).toEqual(
        expect.arrayContaining(['Org A', 'Org B', 'Org C']),
      )
    })

    it('should return an empty array when no organizations exist', async () => {
      const orgs = await listOrganizations()
      expect(orgs).toEqual([])
    })
  })

  describe('deletion cascade', () => {
    it('should cascade delete teams when an organization is deleted', async () => {
      const input: CreateOrganizationInput = {
        name: 'Cascade Org',
        slug: 'cascade-org',
      }

      const org = await createOrganization(input)

      await db('teams').insert({
        name: 'Team A',
        slug: 'team-a',
        organization_id: org.id,
      })

      await db('teams').insert({
        name: 'Team B',
        slug: 'team-b',
        organization_id: org.id,
      })

      // Verify teams exist before deletion
      const teamsBefore = await db('teams').where({ organization_id: org.id })
      expect(teamsBefore).toHaveLength(2)

      // Delete the organization
      await db('organizations').where({ id: org.id }).delete()

      // Verify teams are cascade deleted
      const teamsAfter = await db('teams').where({ organization_id: org.id })
      expect(teamsAfter).toHaveLength(0)

      // Verify org itself is gone
      const deletedOrg = await getOrganizationById(org.id)
      expect(deletedOrg).toBeNull()
    })

    it('should cascade delete memberships when an organization is deleted', async () => {
      const input: CreateOrganizationInput = {
        name: 'Membership Cascade Org',
        slug: 'membership-cascade-org',
      }

      const org = await createOrganization(input)

      await db('memberships').insert({
        user_id: 'user-cascade-1',
        organization_id: org.id,
        role: 'member',
      })

      await db('memberships').insert({
        user_id: 'user-cascade-2',
        organization_id: org.id,
        role: 'admin',
      })

      // Verify memberships exist
      const membershipsBefore = await db('memberships').where({
        organization_id: org.id,
      })
      expect(membershipsBefore).toHaveLength(2)

      // Delete the organization
      await db('organizations').where({ id: org.id }).delete()

      // Verify memberships are cascade deleted
      const membershipsAfter = await db('memberships').where({
        organization_id: org.id,
      })
      expect(membershipsAfter).toHaveLength(0)
    })

    it('should cascade delete both teams and memberships', async () => {
      const input: CreateOrganizationInput = {
        name: 'Full Cascade Org',
        slug: 'full-cascade-org',
      }

      const org = await createOrganization(input)

      const [team] = await db('teams')
        .insert({
          name: 'Cascade Team',
          slug: 'cascade-team',
          organization_id: org.id,
        })
        .returning('*')

      // User is a member of the org and also part of a team
      await db('memberships').insert({
        user_id: 'user-full-cascade',
        organization_id: org.id,
        team_id: team.id,
        role: 'member',
      })

      // Direct org membership too
      await db('memberships').insert({
        user_id: 'user-org-only',
        organization_id: org.id,
        role: 'viewer',
      })

      // Delete the organization
      await db('organizations').where({ id: org.id }).delete()

      // Verify everything is cleaned up
      const teams = await db('teams').where({ organization_id: org.id })
      expect(teams).toHaveLength(0)

      const memberships = await db('memberships').where({
        organization_id: org.id,
      })
      expect(memberships).toHaveLength(0)
    })
  })

  describe('invalid-input rejection', () => {
    it('should reject an empty name', async () => {
      const input: CreateOrganizationInput = {
        name: '',
        slug: 'empty-name',
      }

      await expect(createOrganization(input)).rejects.toThrow()
    })

    it('should reject an empty slug', async () => {
      const input: CreateOrganizationInput = {
        name: 'Empty Slug',
        slug: '',
      }

      await expect(createOrganization(input)).rejects.toThrow()
    })

    it('should reject a very long name', async () => {
      const input: CreateOrganizationInput = {
        name: 'x'.repeat(500),
        slug: 'long-name',
      }

      await expect(createOrganization(input)).rejects.toThrow()
    })

    it('should reject a very long slug', async () => {
      const input: CreateOrganizationInput = {
        name: 'Long Slug',
        slug: 'x'.repeat(500),
      }

      await expect(createOrganization(input)).rejects.toThrow()
    })

    it('should reject a null name', async () => {
      const input = {
        name: null,
        slug: 'null-name',
      } as unknown as CreateOrganizationInput

      await expect(createOrganization(input)).rejects.toThrow()
    })

    it('should reject a null slug', async () => {
      const input = {
        name: 'Null Slug',
        slug: null,
      } as unknown as CreateOrganizationInput

      await expect(createOrganization(input)).rejects.toThrow()
    })
  })
})
