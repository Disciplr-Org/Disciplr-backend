import knex, { type Knex } from 'knex'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from '@jest/globals'
import { purgeSoftDeletedVaults } from '../services/retention.js'

let temporaryTestDbName: string | null = null

const createRetentionTestDatabase = async (): Promise<Knex> => {
  const baseDatabaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres'
  const adminUrl = new URL(baseDatabaseUrl)
  adminUrl.pathname = '/postgres'

  temporaryTestDbName = `disciplr_test_retention_${Date.now()}_${Math.floor(Math.random() * 10000)}`
  const adminDb = knex({ client: 'pg', connection: adminUrl.toString(), pool: { min: 1, max: 1 } })
  try {
    await adminDb.raw(`CREATE DATABASE "${temporaryTestDbName}"`)
  } finally {
    await adminDb.destroy()
  }

  const testUrl = new URL(baseDatabaseUrl)
  testUrl.pathname = `/${temporaryTestDbName}`
  const db = knex({ client: 'pg', connection: testUrl.toString(), pool: { min: 1, max: 2 } })

  await db.raw('select 1')

  await db.schema.createTable('organizations', (table) => {
    table.string('id', 255).primary()
    table.string('name', 255).notNullable()
    table.string('slug', 255).notNullable()
    table.jsonb('metadata').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
  })

  await db.schema.createTable('vaults', (table) => {
    table.string('id', 255).primary()
    table.string('creator', 255).notNullable()
    table.decimal('amount', 32, 7).notNullable()
    table.timestamp('start_timestamp', { useTz: true }).notNullable()
    table.timestamp('end_timestamp', { useTz: true }).notNullable()
    table.string('success_destination', 255).notNullable()
    table.string('failure_destination', 255).notNullable()
    table.string('status', 64).notNullable()
    table.timestamp('deleted_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
    table.string('organization_id', 255).nullable()
    table
      .foreign('organization_id')
      .references('id')
      .inTable('organizations')
      .onDelete('SET NULL')
  })

  await db.schema.createTable('milestones', (table) => {
    table.string('id', 255).primary()
    table.string('vault_id', 255).notNullable()
    table.string('title', 255).notNullable()
    table.string('description', 1024).notNullable()
    table.decimal('target_amount', 32, 7).notNullable()
    table.decimal('current_amount', 32, 7).notNullable().defaultTo('0')
    table.timestamp('deadline', { useTz: true }).notNullable()
    table.string('status', 64).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
    table
      .foreign('vault_id')
      .references('id')
      .inTable('vaults')
      .onDelete('CASCADE')
  })

  return db
}

describe('Retention Service - purgeSoftDeletedVaults', () => {
  let db: Knex

  beforeAll(async () => {
    db = await createRetentionTestDatabase()
  })

  afterAll(async () => {
    await db.destroy()

    if (temporaryTestDbName) {
      const adminUrl = new URL(process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/postgres')
      adminUrl.pathname = '/postgres'
      const adminDb = knex({ client: 'pg', connection: adminUrl.toString(), pool: { min: 1, max: 1 } })
      try {
        await adminDb.raw(`DROP DATABASE IF EXISTS "${temporaryTestDbName}"`)
      } finally {
        await adminDb.destroy()
      }
    }
  })

  beforeEach(async () => {
    delete process.env.RETENTION_PURGE_AGE_MS
    await db('milestones').delete()
    await db('vaults').delete()
    await db('organizations').delete()
  })

  it('deletes only soft-deleted vaults for the specified organization and counts cascade milestones', async () => {
    const [organization] = await db('organizations')
      .insert({ id: 'org-one', name: 'Org One', slug: 'org-one' })
      .returning('*')

    await db('vaults').insert([
      {
        id: 'vault-org1-1',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'cancelled',
        deleted_at: new Date('2025-01-01T00:00:00Z'),
        created_at: new Date(),
        organization_id: organization.id,
      },
      {
        id: 'vault-org1-2',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXYYYYYYYY',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXYYYYYYYY',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXYYYYYYYY',
        status: 'active',
        deleted_at: null,
        created_at: new Date(),
        organization_id: organization.id,
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-org1-1',
        vault_id: 'vault-org1-1',
        title: 'Milestone One',
        description: 'Soft deleted vault milestone',
        target_amount: '500.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-org1-2',
        vault_id: 'vault-org1-1',
        title: 'Milestone Two',
        description: 'Soft deleted vault milestone',
        target_amount: '500.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-org1-3',
        vault_id: 'vault-org1-2',
        title: 'Active Vault Milestone',
        description: 'Active vault milestone should remain',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-07-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults(organization.id, 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 2 })

    const remainingVaults = await db('vaults').select('id', 'deleted_at', 'organization_id')
    expect(remainingVaults).toHaveLength(1)
    expect(remainingVaults[0].id).toBe('vault-org1-2')

    const remainingMilestones = await db('milestones').select('id', 'vault_id')
    expect(remainingMilestones).toHaveLength(1)
    expect(remainingMilestones[0].vault_id).toBe('vault-org1-2')
  })

  it('honors batchSize and deletes only one soft-deleted vault per batch', async () => {
    const [organization] = await db('organizations')
      .insert({ id: 'org-batch', name: 'Org Batch', slug: 'org-batch' })
      .returning('*')

    await db('vaults').insert([
      {
        id: 'vault-batch-1',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAA',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAA',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAA',
        status: 'cancelled',
        deleted_at: new Date('2025-01-01T00:00:00Z'),
        created_at: new Date(),
        organization_id: organization.id,
      },
      {
        id: 'vault-batch-2',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBB',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBB',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBB',
        status: 'failed',
        deleted_at: new Date('2025-01-02T00:00:00Z'),
        created_at: new Date(),
        organization_id: organization.id,
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-batch-1',
        vault_id: 'vault-batch-1',
        title: 'Batch Milestone One',
        description: 'First soft deleted vault milestone',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-03-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-batch-2',
        vault_id: 'vault-batch-2',
        title: 'Batch Milestone Two',
        description: 'Second soft deleted vault milestone',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-04-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults(organization.id, 1, db)

    expect(result.deletedVaults).toBe(1)
    expect(result.deletedMilestones).toBe(1)

    const remainingDeletedVaults = await db('vaults')
      .where({ organization_id: organization.id })
      .whereNotNull('deleted_at')
      .select('id')

    expect(remainingDeletedVaults).toHaveLength(1)
  })

  it('does not purge soft-deleted vaults from other organizations', async () => {
    await db('organizations').insert([
      { id: 'org-one', name: 'Org One', slug: 'org-one' },
      { id: 'org-two', name: 'Org Two', slug: 'org-two' },
    ])

    await db('vaults').insert([
      {
        id: 'vault-org-one',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAAA',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAAA',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXAAAAAAAA',
        status: 'cancelled',
        deleted_at: new Date('2025-01-01T00:00:00Z'),
        created_at: new Date(),
        organization_id: 'org-one',
      },
      {
        id: 'vault-org-two',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBBB',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBBB',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXBBBBBBBB',
        status: 'cancelled',
        deleted_at: new Date('2025-01-01T00:00:00Z'),
        created_at: new Date(),
        organization_id: 'org-two',
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-org-one',
        vault_id: 'vault-org-one',
        title: 'Org One Milestone',
        description: 'Belongs to org one',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-org-two',
        vault_id: 'vault-org-two',
        title: 'Org Two Milestone',
        description: 'Belongs to org two',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults('org-one', 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 1 })

    const remainingOrgTwoVaults = await db('vaults')
      .where({ organization_id: 'org-two' })
      .select('id')

    expect(remainingOrgTwoVaults).toHaveLength(1)
    expect(remainingOrgTwoVaults[0].id).toBe('vault-org-two')
  })

  it('respects RETENTION_PURGE_AGE_MS and excludes recently deleted vaults', async () => {
    process.env.RETENTION_PURGE_AGE_MS = String(24 * 60 * 60 * 1000)

    await db('organizations').insert({ id: 'org-window', name: 'Org Window', slug: 'org-window' })

    await db('vaults').insert([
      {
        id: 'vault-window-old',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXCCCCCCCC',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXCCCCCCCC',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXCCCCCCCC',
        status: 'cancelled',
        deleted_at: new Date(Date.now() - 36 * 60 * 60 * 1000),
        created_at: new Date(),
        organization_id: 'org-window',
      },
      {
        id: 'vault-window-recent',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXDDDDDDDD',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXDDDDDDDD',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXDDDDDDDD',
        status: 'cancelled',
        deleted_at: new Date(Date.now() - 2 * 60 * 60 * 1000),
        created_at: new Date(),
        organization_id: 'org-window',
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-window-old',
        vault_id: 'vault-window-old',
        title: 'Old Deleted Vault Milestone',
        description: 'Should be removed',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-window-recent',
        vault_id: 'vault-window-recent',
        title: 'Recent Deleted Vault Milestone',
        description: 'Should remain',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults('org-window', 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 1 })

    const remainingVaults = await db('vaults')
      .where({ organization_id: 'org-window' })
      .whereNotNull('deleted_at')
      .select('id')

    expect(remainingVaults).toHaveLength(1)
    expect(remainingVaults[0].id).toBe('vault-window-recent')
  })

  it('uses per-org retention_purge_age_ms from metadata when env var is unset', async () => {
    delete process.env.RETENTION_PURGE_AGE_MS

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000)

    await db('organizations').insert({
      id: 'org-per-org-window',
      name: 'Org Per-Org',
      slug: 'org-per-org',
      metadata: { retention_purge_age_ms: 24 * 60 * 60 * 1000 },
    })

    await db('vaults').insert([
      {
        id: 'vault-per-org-old',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXEEEEEEEE',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXEEEEEEEE',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXEEEEEEEE',
        status: 'cancelled',
        deleted_at: twoDaysAgo,
        created_at: new Date(),
        organization_id: 'org-per-org-window',
      },
      {
        id: 'vault-per-org-recent',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXFFFFFFFF',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXFFFFFFFF',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXFFFFFFFF',
        status: 'cancelled',
        deleted_at: sixHoursAgo,
        created_at: new Date(),
        organization_id: 'org-per-org-window',
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-per-org-old',
        vault_id: 'vault-per-org-old',
        title: 'Old Milestone',
        description: 'Should be removed',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-per-org-recent',
        vault_id: 'vault-per-org-recent',
        title: 'Recent Milestone',
        description: 'Should remain',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults('org-per-org-window', 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 1 })

    const remaining = await db('vaults')
      .where({ organization_id: 'org-per-org-window' })
      .whereNotNull('deleted_at')
      .select('id')

    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('vault-per-org-recent')
  })

  it('env var RETENTION_PURGE_AGE_MS takes precedence over per-org metadata', async () => {
    process.env.RETENTION_PURGE_AGE_MS = String(2 * 60 * 60 * 1000) // 2 hours

    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    const oneHourAgo = new Date(Date.now() - 1 * 60 * 60 * 1000)

    await db('organizations').insert({
      id: 'org-precedence',
      name: 'Org Precedence',
      slug: 'org-precedence',
      metadata: { retention_purge_age_ms: 7 * 24 * 60 * 60 * 1000 },
    })

    await db('vaults').insert([
      {
        id: 'vault-precedence-old',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXGGGGGGGG',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXGGGGGGGG',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXGGGGGGGG',
        status: 'cancelled',
        deleted_at: twoDaysAgo,
        created_at: new Date(),
        organization_id: 'org-precedence',
      },
      {
        id: 'vault-precedence-recent',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXHHHHHHHH',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXHHHHHHHH',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXHHHHHHHH',
        status: 'cancelled',
        deleted_at: oneHourAgo,
        created_at: new Date(),
        organization_id: 'org-precedence',
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-precedence-old',
        vault_id: 'vault-precedence-old',
        title: 'Old Milestone',
        description: 'Should be removed',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        id: 'milestone-precedence-recent',
        vault_id: 'vault-precedence-recent',
        title: 'Recent Milestone',
        description: 'Should remain',
        target_amount: '2000.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults('org-precedence', 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 1 })

    const remaining = await db('vaults')
      .where({ organization_id: 'org-precedence' })
      .whereNotNull('deleted_at')
      .select('id')

    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('vault-precedence-recent')
  })

  it('applies default 30-day retention window when no config is provided', async () => {
    delete process.env.RETENTION_PURGE_AGE_MS

    await db('organizations').insert({
      id: 'org-default-window',
      name: 'Org Default',
      slug: 'org-default',
      metadata: null,
    })

    await db('vaults').insert([
      {
        id: 'vault-default-old',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXIIIIIIII',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01T00:00:00Z'),
        end_timestamp: new Date('2024-06-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXIIIIIIII',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXIIIIIIII',
        status: 'cancelled',
        deleted_at: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        created_at: new Date(),
        organization_id: 'org-default-window',
      },
      {
        id: 'vault-default-recent',
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXJJJJJJJJ',
        amount: '2000.0000000',
        start_timestamp: new Date('2024-02-01T00:00:00Z'),
        end_timestamp: new Date('2024-07-01T00:00:00Z'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXJJJJJJJJ',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXJJJJJJJJ',
        status: 'cancelled',
        deleted_at: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
        created_at: new Date(),
        organization_id: 'org-default-window',
      },
    ])

    await db('milestones').insert([
      {
        id: 'milestone-default-old',
        vault_id: 'vault-default-old',
        title: 'Old Milestone',
        description: 'Should be removed',
        target_amount: '1000.0000000',
        current_amount: '0',
        deadline: new Date('2024-05-01T00:00:00Z'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      },
    ])

    const result = await purgeSoftDeletedVaults('org-default-window', 10, db)

    expect(result).toEqual({ deletedVaults: 1, deletedMilestones: 1 })

    const remaining = await db('vaults')
      .where({ organization_id: 'org-default-window' })
      .whereNotNull('deleted_at')
      .select('id')

    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('vault-default-recent')
  })

  it('throws when RETENTION_PURGE_AGE_MS is not a valid non-negative integer', async () => {
    process.env.RETENTION_PURGE_AGE_MS = 'invalid'

    await db('organizations').insert({ id: 'org-invalid', name: 'Org Invalid', slug: 'org-invalid' })

    await expect(purgeSoftDeletedVaults('org-invalid', 10, db)).rejects.toThrow(
      'RETENTION_PURGE_AGE_MS must be a non-negative integer',
    )
  })
})
