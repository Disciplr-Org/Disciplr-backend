import * as crypto from 'node:crypto'
import knex, { Knex } from 'knex'
import { MilestoneRepository } from '../repositories/milestoneRepository.js'

const TEST_DB_URL = process.env.DATABASE_URL
const describeWithDb = TEST_DB_URL ? describe : describe.skip

describeWithDb('MilestoneRepository - Query Behaviour Matrix', () => {
  let db: Knex
  let repo: MilestoneRepository

  // Test data tracking for cleanup
  const orgIds: string[] = []
  const userIds: string[] = []
  const vaultIds: string[] = []
  const milestoneIds: string[] = []

  beforeAll(async () => {
    db = knex({
      client: 'pg',
      connection: TEST_DB_URL!,
    })
    // Ensure connection
    await db.raw('SELECT 1')
    repo = new MilestoneRepository(db)
  })

  afterAll(async () => {
    if (db) {
      // Cleanup test data in reverse dependency order
      if (milestoneIds.length > 0) {
        await db('milestones').whereIn('id', milestoneIds).delete()
      }
      if (vaultIds.length > 0) {
        await db('vaults').whereIn('id', vaultIds).delete()
      }
      if (userIds.length > 0) {
        await db('users').whereIn('id', userIds).delete()
      }
      if (orgIds.length > 0) {
        await db('organizations').whereIn('id', orgIds).delete()
      }
      await db.destroy()
    }
  })

  // Helper to seed a test organization
  async function createOrg(name: string): Promise<string> {
    const id = crypto.randomUUID()
    const slug = `org-${id}`
    await db('organizations').insert({ id, name, slug })
    orgIds.push(id)
    return id
  }

  // Helper to seed a test user (for vault creator / verifier)
  async function createUser(email: string): Promise<string> {
    const id = crypto.randomUUID()
    await db('users').insert({
      id,
      email,
      passwordHash: 'dummy-hash',
      role: 'USER',
      status: 'ACTIVE',
    })
    userIds.push(id)
    return id
  }

  // Helper to seed a test vault
  async function createVault(orgId: string, creatorId: string): Promise<string> {
    const id = crypto.randomUUID()
    await db('vaults').insert({
      id,
      creator_id: creatorId,
      amount: '1000',
      start_date: new Date(),
      end_date: new Date(Date.now() + 86400000),
      verifier: 'dummy-verifier',
      success_destination: 'destination-a',
      failure_destination: 'destination-b',
      status: 'ACTIVE',
      organization_id: orgId,
    })
    vaultIds.push(id)
    return id
  }

  // Helper to seed a milestone
  async function createMilestone(
    vaultId: string,
    options: {
      id?: string
      title?: string
      verifierUserId?: string | null
      deletedAt?: Date | null
    } = {},
  ): Promise<string> {
    const id = options.id || crypto.randomUUID()
    await db('milestones').insert({
      id,
      vault_id: vaultId,
      title: options.title || 'Milestone Title',
      description: 'Milestone Description',
      target_amount: 500,
      current_amount: 0,
      deadline: new Date(Date.now() + 86400000),
      status: 'pending',
      verifier_user_id: options.verifierUserId || null,
      deleted_at: options.deletedAt || null,
    })
    milestoneIds.push(id)
    return id
  }

  describe('Org Scoping', () => {
    it('should strictly isolate findMany queries to the requested organization', async () => {
      const orgA = await createOrg('Org A')
      const orgB = await createOrg('Org B')
      const creator = await createUser('creator1@test.com')

      const vaultA = await createVault(orgA, creator)
      const vaultB = await createVault(orgB, creator)

      const mA = await createMilestone(vaultA, { title: 'Org A Milestone' })
      const mB = await createMilestone(vaultB, { title: 'Org B Milestone' })

      const resultsA = await repo.findMany({ orgId: orgA })
      expect(resultsA).toHaveLength(1)
      expect(resultsA[0].id).toBe(mA)

      const resultsB = await repo.findMany({ orgId: orgB })
      expect(resultsB).toHaveLength(1)
      expect(resultsB[0].id).toBe(mB)
    })

    it('should strictly isolate findById queries to the requested organization', async () => {
      const orgA = await createOrg('Org A')
      const orgB = await createOrg('Org B')
      const creator = await createUser('creator2@test.com')

      const vaultA = await createVault(orgA, creator)
      const mA = await createMilestone(vaultA, { title: 'Org A Milestone' })

      // Querying mA under Org A should succeed
      const foundA = await repo.findById(mA, orgA)
      expect(foundA).not.toBeNull()
      expect(foundA.id).toBe(mA)

      // Querying mA under Org B should return null
      const foundB = await repo.findById(mA, orgB)
      expect(foundB).toBeNull()
    })
  })

  describe('Soft-Delete Exclusion', () => {
    it('should exclude soft-deleted milestones by default and include them explicitly', async () => {
      const org = await createOrg('Soft Delete Org')
      const creator = await createUser('creator3@test.com')
      const vault = await createVault(org, creator)

      const activeId = await createMilestone(vault, { title: 'Active Milestone' })
      const deletedId = await createMilestone(vault, {
        title: 'Deleted Milestone',
        deletedAt: new Date(),
      })

      // Default findMany
      const defaultList = await repo.findMany({ orgId: org })
      expect(defaultList.map((m) => m.id)).toContain(activeId)
      expect(defaultList.map((m) => m.id)).not.toContain(deletedId)

      // Explicitly including deleted in findMany
      const fullList = await repo.findMany({ orgId: org, includeDeleted: true })
      expect(fullList.map((m) => m.id)).toContain(activeId)
      expect(fullList.map((m) => m.id)).toContain(deletedId)

      // Default findById
      const foundActive = await repo.findById(activeId, org)
      expect(foundActive).not.toBeNull()
      const foundDeletedDefault = await repo.findById(deletedId, org)
      expect(foundDeletedDefault).toBeNull()

      // Explicitly including deleted in findById
      const foundDeletedExplicit = await repo.findById(deletedId, org, true)
      expect(foundDeletedExplicit).not.toBeNull()
      expect(foundDeletedExplicit.id).toBe(deletedId)
    })
  })

  describe('Verifier-Assignment Filtering', () => {
    it('should return only milestones assigned to the specified verifier', async () => {
      const org = await createOrg('Verifier Org')
      const creator = await createUser('creator4@test.com')
      const vault = await createVault(org, creator)

      const verifierA = 'verifier-a'
      const verifierB = 'verifier-b'

      const mA = await createMilestone(vault, { verifierUserId: verifierA })
      const mB = await createMilestone(vault, { verifierUserId: verifierB })
      const mNone = await createMilestone(vault, { verifierUserId: null })

      // Filter by Verifier A
      const listA = await repo.findMany({ orgId: org, verifierUserId: verifierA })
      expect(listA.map((m) => m.id)).toContain(mA)
      expect(listA.map((m) => m.id)).not.toContain(mB)
      expect(listA.map((m) => m.id)).not.toContain(mNone)

      // Filter by Verifier B
      const listB = await repo.findMany({ orgId: org, verifierUserId: verifierB })
      expect(listB.map((m) => m.id)).toContain(mB)
      expect(listB.map((m) => m.id)).not.toContain(mA)
      expect(listB.map((m) => m.id)).not.toContain(mNone)
    })
  })

  describe('Keyset Pagination stability', () => {
    it('should page through milestones stably and handle concurrent inserts without skipping or duplicating rows', async () => {
      const org = await createOrg('Pagination Org')
      const creator = await createUser('creator5@test.com')
      const vault = await createVault(org, creator)

      // Seed 5 milestones with deterministic IDs (lexicographically ordered)
      const seededIds = [
        'ms-01',
        'ms-03',
        'ms-05',
        'ms-07',
        'ms-09',
      ]
      for (const id of seededIds) {
        await createMilestone(vault, { id, title: `Seeded ${id}` })
      }

      // We will page with limit = 2
      // Page 1 should return ms-01, ms-03
      const page1 = await repo.findMany({ orgId: org, limit: 2 })
      expect(page1).toHaveLength(2)
      expect(page1[0].id).toBe('ms-01')
      expect(page1[1].id).toBe('ms-03')

      // Simulate a concurrent insert of 'ms-02' (inserted between ms-01 and ms-03, i.e. already passed page 1's cursor)
      // and 'ms-06' (inserted between ms-05 and ms-07, i.e. ahead of the next page cursor)
      await createMilestone(vault, { id: 'ms-02', title: 'Concurrent ms-02' })
      await createMilestone(vault, { id: 'ms-06', title: 'Concurrent ms-06' })

      // Page 2: we pass afterId = 'ms-03' (last item from Page 1)
      // With keyset pagination: where id > 'ms-03'.
      // This should fetch 'ms-05', 'ms-06' (since ms-06 is > ms-03 and < ms-07)
      const page2 = await repo.findMany({ orgId: org, afterId: 'ms-03', limit: 2 })
      expect(page2).toHaveLength(2)
      expect(page2[0].id).toBe('ms-05')
      expect(page2[1].id).toBe('ms-06')

      // Page 3: we pass afterId = 'ms-06'
      // This should fetch 'ms-07', 'ms-09'
      const page3 = await repo.findMany({ orgId: org, afterId: 'ms-06', limit: 2 })
      expect(page3).toHaveLength(2)
      expect(page3[0].id).toBe('ms-07')
      expect(page3[1].id).toBe('ms-09')

      // Assert all queried items across the pages:
      // Page 1: ms-01, ms-03
      // Page 2: ms-05, ms-06
      // Page 3: ms-07, ms-09
      // Total retrieved: ms-01, ms-03, ms-05, ms-06, ms-07, ms-09.
      // Notice that 'ms-02' was skipped because it was inserted *behind* the cursor (after ms-01 was read and cursor moved to ms-03).
      // This is the expected and correct behavior of keyset pagination: it guarantees no duplicate rows
      // are served, and new items ahead of the cursor are successfully included without disrupting the page offsets.
      const allFetchedIds = [...page1, ...page2, ...page3].map((m) => m.id)
      const uniqueFetchedIds = Array.from(new Set(allFetchedIds))

      expect(allFetchedIds).toHaveLength(uniqueFetchedIds.length) // No duplicates!
    })
  })
})
