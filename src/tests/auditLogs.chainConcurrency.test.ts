import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import knex, { Knex } from 'knex'
import { beforeAll, afterAll, describe, expect, it } from '@jest/globals'
import { db } from '../db/knex.js'
import { createAuditLog, verifyAuditLogChain } from '../lib/audit-logs.js'

const migrationRequire = createRequire(import.meta.url)
const chainSequenceMigration = migrationRequire(
  '../../db/migrations/20261018200000_add_audit_log_chain_seq.cjs',
) as {
  up: (database: Knex) => Promise<void>
  down: (database: Knex) => Promise<void>
}

const describeWithPostgres = process.env.DATABASE_URL ? describe : describe.skip
const organizationA = randomUUID()
const organizationB = randomUUID()
let databaseAvailable = false

describeWithPostgres('Audit log hash-chain concurrency', () => {
  beforeAll(async () => {
    try {
      await db.raw('SELECT 1')
    } catch {
      console.warn('Skipping audit chain integration tests: no PostgreSQL connection available')
      return
    }
    databaseAvailable = true
    if (!(await db.schema.hasColumn('audit_logs', 'chain_seq'))) {
      throw new Error('Run database migrations before the audit chain tests')
    }
  })

  afterAll(async () => {
    if (!databaseAvailable) return
    await db('audit_logs').whereIn('organization_id', [organizationA, organizationB]).delete()
  })

  it(
    'serializes concurrent writes per organization without blocking other organizations',
    async () => {
      if (!databaseAvailable) return
      const runBatch = async (organizationId: string) => {
        const startedAt = Date.now()
        await Promise.all(
          Array.from({ length: 50 }, (_, index) =>
            createAuditLog({
              actor_user_id: 'system',
              organization_id: organizationId,
              action: 'audit.test',
              target_type: 'concurrency',
              target_id: `${organizationId}-${index}`,
              metadata: {},
            }),
          ),
        )
        return { startedAt, finishedAt: Date.now() }
      }

      const [batchA, batchB] = await Promise.all([
        runBatch(organizationA),
        runBatch(organizationB),
      ])

      expect(Math.max(batchA.startedAt, batchB.startedAt)).toBeLessThan(
        Math.min(batchA.finishedAt, batchB.finishedAt),
      )
      const resultA = await verifyAuditLogChain(organizationA)
      const resultB = await verifyAuditLogChain(organizationB)
      expect(resultA.verified).toBe(true)
      expect(resultA.checked_count).toBe(50)
      expect(resultB.verified).toBe(true)
      expect(resultB.checked_count).toBe(50)
    },
    60000,
  )

  it('rejects a manually inserted row with a duplicate predecessor', async () => {
    if (!databaseAvailable) return
    const original = await createAuditLog({
      actor_user_id: 'system',
      organization_id: organizationA,
      action: 'audit.test',
      target_type: 'fork',
      target_id: 'original',
      metadata: {},
    })

    const inserted = await db('audit_logs').where('id', original.id).first()
    await expect(
      db('audit_logs').insert({
        id: randomUUID(),
        actor_user_id: 'system',
        organization_id: organizationA,
        action: 'audit.test',
        target_type: 'fork',
        target_id: 'duplicate',
        metadata: {},
        created_at: new Date(),
        chain_seq: (BigInt(inserted.chain_seq) + 1n).toString(),
        prev_hash: inserted.prev_hash,
        row_hash: 'f'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: '23505' })
  })

  it('backfills chain_seq in creation order and rolls the migration back', async () => {
    if (!databaseAvailable) return
    const schemaName = `audit_chain_test_${randomUUID().replace(/-/g, '')}`
    await db.raw('CREATE SCHEMA ??', [schemaName])

    const migrationDb = knex({
      client: 'pg',
      connection: {
        connectionString: process.env.DATABASE_URL,
        options: `-c search_path=${schemaName}`,
      },
      pool: { min: 1, max: 1 },
    })

    try {
      await migrationDb.raw(`
        CREATE TABLE audit_logs (
          id uuid PRIMARY KEY,
          actor_user_id text NOT NULL,
          organization_id uuid NULL,
          action text NOT NULL,
          target_type text NOT NULL,
          target_id text NOT NULL,
          metadata jsonb NOT NULL DEFAULT '{}',
          created_at timestamptz NOT NULL,
          prev_hash varchar(64),
          row_hash varchar(64)
        )
      `)

      const orgId = randomUUID()
      await migrationDb('audit_logs').insert([
        {
          id: randomUUID(),
          actor_user_id: 'system',
          organization_id: null,
          action: 'audit.test',
          target_type: 'migration',
          target_id: 'global',
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00Z'),
          prev_hash: 'e'.repeat(64),
          row_hash: 'f'.repeat(64),
        },
        {
          id: randomUUID(),
          actor_user_id: 'system',
          organization_id: orgId,
          action: 'audit.test',
          target_type: 'migration',
          target_id: 'later',
          metadata: {},
          created_at: new Date('2026-01-02T00:00:00Z'),
          prev_hash: 'b'.repeat(64),
          row_hash: 'c'.repeat(64),
        },
        {
          id: randomUUID(),
          actor_user_id: 'system',
          organization_id: orgId,
          action: 'audit.test',
          target_type: 'migration',
          target_id: 'earlier',
          metadata: {},
          created_at: new Date('2026-01-01T00:00:00Z'),
          prev_hash: 'a'.repeat(64),
          row_hash: 'd'.repeat(64),
        },
      ])

      await chainSequenceMigration.up(migrationDb)
      const rows = await migrationDb('audit_logs').orderBy('chain_seq', 'asc')
      expect(rows.map((row: { target_id: string; chain_seq: string }) => [
        row.target_id,
        Number(row.chain_seq),
      ])).toEqual([
        ['earlier', 1],
        ['later', 2],
      ])
      const [globalRow] = await migrationDb('audit_logs')
        .whereNull('organization_id')
        .select('chain_seq')
      expect(Number(globalRow.chain_seq)).toBe(1)

      await chainSequenceMigration.down(migrationDb)
      expect(await migrationDb.schema.hasColumn('audit_logs', 'chain_seq')).toBe(false)
      expect(await migrationDb.schema.hasColumn('audit_logs', 'prev_hash')).toBe(true)
    } finally {
      await migrationDb.destroy()
      await db.raw('DROP SCHEMA ?? CASCADE', [schemaName])
    }
  }, 30000)
})
