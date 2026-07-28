import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { db } from '../../db/knex.js'

/**
 * Issue #754 — EXPLAIN regression test.
 * 
 * Seeds enough rows per organization/user that the planner has a real
 * reason to prefer an index scan over a sequential one, then asserts the
 * plan for each hot query does NOT contain a Seq Scan on the target table.
 * 
 * A tiny table will happily get seq-scanned even with a perfectly good
 * index (cheaper for the planner), so row counts here are deliberately
 * large enough (5k+ per table, skewed toward one org/user so the filtered
 * row count is still small relative to the table) to make the index the
 * cheaper choice — this is what makes the test meaningful rather than
 * tautological.
 */

const ORG_A = randomUUID()
const ORG_B = randomUUID()
const USER_A = randomUUID()
const ROWS_PER_TABLE = 6000

type PlanNode = {
  'Node Type'?: string
  'Relation Name'?: string
  Plans?: PlanNode[]
}

function collectNodes(node: PlanNode, acc: PlanNode[] = []): PlanNode[] {
  acc.push(node)
  for (const child of node.Plans ?? []) collectNodes(child, acc)
  return acc
}

async function explain(query: Knex.QueryBuilder | { toSQL: () => { sql: string; bindings: any[] } }): Promise<PlanNode> {
  const { sql, bindings } = (query as any).toSQL()
  const result = await db.raw(`EXPLAIN (FORMAT JSON) ${sql}`, bindings)
  return result.rows[0]['QUERY PLAN'][0].Plan as PlanNode
}

function assertNoSeqScan(plan: PlanNode, table: string) {
  const nodes = collectNodes(plan)
  const seqScanOnTable = nodes.find(
    (n) => n['Node Type'] === 'Seq Scan' && n['Relation Name'] === table,
  )
  expect(seqScanOnTable).toBeUndefined()
}

beforeAll(async () => {
  // First, ensure our migration has run to create the indexes
  // This assumes the test database is fresh or migrations are up to date
  
  // audit_logs
  const auditRows = Array.from({ length: ROWS_PER_TABLE }, (_, i) => ({
    id: randomUUID(),
    actor_user_id: randomUUID(),
    organization_id: i % 50 === 0 ? ORG_A : ORG_B,
    action: 'test.action',
    target_type: 'test_target',
    target_id: randomUUID(),
    metadata: JSON.stringify({}),
    created_at: new Date(Date.now() - i * 1000).toISOString(),
    prev_hash: '0'.repeat(64),
    row_hash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
  }))
  await db.batchInsert('audit_logs', auditRows, 500)

  // webhook_subscribers
  const webhookRows = Array.from({ length: ROWS_PER_TABLE }, (_, i) => ({
    id: randomUUID(),
    organization_id: i % 50 === 0 ? ORG_A : ORG_B,
    url: `https://example.test/hook/${i}`,
    secret: 'plaintext-secret-for-test',
    events: JSON.stringify([]),
    active: true,
    schema_version: 1,
    field_policy: JSON.stringify({}),
  }))
  await db.batchInsert('webhook_subscribers', webhookRows, 500)

  // vaults (need to create organizations first for FK)
  await db('organizations').insert([
    { id: ORG_A, name: 'Test Org A', slug: 'test-org-a', metadata: {} },
    { id: ORG_B, name: 'Test Org B', slug: 'test-org-b', metadata: {} },
  ])

  const vaultRows = Array.from({ length: ROWS_PER_TABLE }, (_, i) => ({
    id: `vault-test-${i}`,
    creator: `creator-${i}`,
    amount: '100.0',
    start_timestamp: new Date(Date.now() - i * 2000).toISOString(),
    end_timestamp: new Date(Date.now() + 86400000).toISOString(),
    success_destination: 'success',
    failure_destination: 'failure',
    status: 'active',
    created_at: new Date(Date.now() - i * 1000).toISOString(),
    organization_id: i % 50 === 0 ? ORG_A : ORG_B,
    deleted_at: i % 100 === 0 ? new Date().toISOString() : null, // Some deleted
  }))
  await db.batchInsert('vaults', vaultRows, 500)

  // notifications
  const notificationRows = Array.from({ length: ROWS_PER_TABLE }, (_, i) => ({
    id: randomUUID(),
    user_id: i % 50 === 0 ? USER_A : randomUUID(),
    type: 'test.type',
    title: 'test title',
    message: 'test message',
    data: null,
    created_at: new Date(Date.now() - i * 1000).toISOString(),
  }))
  await db.batchInsert('notifications', notificationRows, 500)
})

afterAll(async () => {
  await db('audit_logs').where({ action: 'test.action' }).del()
  await db('webhook_subscribers').where({ url: db.raw("url like 'https://example.test/hook/%'") }).del()
  await db('vaults').where({ id: db.raw("id like 'vault-test-%'") }).del()
  await db('notifications').where({ type: 'test.type' }).del()
  await db('organizations').whereIn('id', [ORG_A, ORG_B]).del()
  await db.destroy()
})

describe('org-scoped list query plans (issue #754)', () => {
  it('uses an index for listAuditLogs-style organization_id lookups', async () => {
    const query = db('audit_logs')
      .select('*')
      .where('organization_id', ORG_A)
      .orderBy('created_at', 'desc')
      .limit(100)
    const plan = await explain(query)
    assertNoSeqScan(plan, 'audit_logs')
  })

  it('uses an index for the audit chain-head lookup (created_at desc, id desc)', async () => {
    const query = db('audit_logs')
      .where('organization_id', ORG_A)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(1)
    const plan = await explain(query)
    assertNoSeqScan(plan, 'audit_logs')
  })

  it('uses an index for chain verification / export (created_at asc, id asc)', async () => {
    const query = db('audit_logs')
      .select('*')
      .where('organization_id', ORG_A)
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
    const plan = await explain(query)
    assertNoSeqScan(plan, 'audit_logs')
  })

  it('uses an index for findByOrg-style webhook_subscribers lookups', async () => {
    const query = db('webhook_subscribers')
      .where({ organization_id: ORG_A, active: true })
      .orderBy('created_at', 'asc')
    const plan = await explain(query)
    assertNoSeqScan(plan, 'webhook_subscribers')
  })

  it('uses an index for org-scoped vaults list with cursor pagination', async () => {
    // Test non-cursor query (first page)
    const query1 = db('vaults')
      .where({ organization_id: ORG_A })
      .whereNull('deleted_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
    const plan1 = await explain(query1)
    assertNoSeqScan(plan1, 'vaults')

    // Test cursor pagination query (simulating second page)
    // Using a timestamp from the middle of our test data
    const midTimestamp = new Date(Date.now() - (ROWS_PER_TABLE / 2) * 1000).toISOString()
    const midId = `vault-test-${Math.floor(ROWS_PER_TABLE / 2)}`
    
    const query2 = db('vaults')
      .where({ organization_id: ORG_A })
      .whereNull('deleted_at')
      .where(function() {
        this.where('created_at', '<', midTimestamp)
          .orWhere(function() {
            this.where('created_at', '=', midTimestamp)
              .andWhere('id', '<', midId)
          })
      })
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
    const plan2 = await explain(query2)
    assertNoSeqScan(plan2, 'vaults')
  })

  it('uses an index for listUserNotifications-style user_id lookups', async () => {
    const query = db('notifications')
      .where({ user_id: USER_A })
      .whereNull('archived_at')
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(20)
    const plan = await explain(query)
    assertNoSeqScan(plan, 'notifications')
  })

  it('rolls back cleanly and removes all four indexes', async () => {
    // Use the actual migration name
    const migrationName = '20260727123000_add_org_scoped_list_indexes.cjs'
    
    // Rollback the migration
    await db.migrate.down({ name: migrationName } as any)
    
    // Check indexes are removed
    const remaining = await db('pg_indexes')
      .whereIn('indexname', [
        'idx_audit_logs_org_created_id',
        'idx_webhook_subscribers_org_active_created',
        'idx_vaults_org_deleted_created_id_desc',
        'idx_notifications_user_created_id',
      ])
      .andWhere('schemaname', '=', 'public')
    
    expect(remaining.length).toBe(0)

    // Restore for any subsequent tests / suite re-runs
    await db.migrate.up({ name: migrationName } as any)
    
    const restored = await db('pg_indexes')
      .whereIn('indexname', [
        'idx_audit_logs_org_created_id',
        'idx_webhook_subscribers_org_active_created',
        'idx_vaults_org_deleted_created_id_desc',
        'idx_notifications_user_created_id',
      ])
      .andWhere('schemaname', '=', 'public')
    
    expect(restored.length).toBe(4)
  })
})