import { afterAll, beforeAll, describe, expect, it } from '@jest/globals'
import type { Knex } from 'knex'
import { db } from '../../db/knex.js'
import {
  assertIndexedPlan,
  explainQueryPlan,
  trackQueries,
} from '../helpers/performanceHelpers.js'

const PERF_ORG_ID = '00000000-0000-4000-8000-000000000687'
const PERF_USER_ID = '00000000-0000-4000-8000-000000000688'
const OTHER_USER_ID = '00000000-0000-4000-8000-000000000689'
const VAULT_COUNT = 240
const TRANSACTION_COUNT = 960
const SMALL_PAGE_SIZE = 10
const LARGE_PAGE_SIZE = 80
const MAX_VAULT_LIST_QUERIES = 3
const MAX_TRANSACTION_LIST_QUERIES = 2

type JsonPlan = unknown

const now = new Date('2026-06-26T12:00:00.000Z')

const perfVaultId = (index: number): string => `vault-plan-${index.toString().padStart(4, '0')}`
const perfMilestoneId = (index: number): string => `milestone-plan-${index.toString().padStart(4, '0')}`
const perfValidationId = (index: number): string => `validation-plan-${index.toString().padStart(4, '0')}`

const cleanup = async (): Promise<void> => {
  await db('transactions').where('tx_hash', 'like', 'plan_hash_%').del()
  await db('validations').where('id', 'like', 'validation-plan-%').del()
  await db('milestones').where('id', 'like', 'milestone-plan-%').del()
  await db('vaults').where('id', 'like', 'vault-plan-%').del()
  await db('analytics_vault_summary').where({ id: 1 }).del()
  await db('organizations').where({ id: PERF_ORG_ID }).del()
  await db('users').whereIn('id', [PERF_USER_ID, OTHER_USER_ID]).del()
}

const seedUsersAndOrg = async (): Promise<void> => {
  await db('organizations').insert({
    id: PERF_ORG_ID,
    name: 'Query Plan Benchmarks',
    slug: 'query-plan-benchmarks',
    metadata: {},
  })

  await db('users').insert([
    {
      id: PERF_USER_ID,
      email: 'query-plan-user@example.com',
      password_hash: 'hash',
    },
    {
      id: OTHER_USER_ID,
      email: 'query-plan-other@example.com',
      password_hash: 'hash',
    },
  ])
}

const seedVaults = async (): Promise<void> => {
  const statuses = ['active', 'completed', 'failed', 'cancelled', 'draft']
  const vaults = Array.from({ length: VAULT_COUNT }, (_, index) => ({
    id: perfVaultId(index),
    creator: `GCREATOR${index.toString().padStart(48, 'X')}`,
    user_id: index % 2 === 0 ? PERF_USER_ID : OTHER_USER_ID,
    organization_id: PERF_ORG_ID,
    amount: String(1000 + index),
    start_date: new Date(now.getTime() - (index + 1) * 60_000),
    end_date: new Date(now.getTime() + (index + 1) * 60_000),
    verifier: `GVERIFIER${index.toString().padStart(47, 'X')}`,
    success_destination: `GSUCCESS${index.toString().padStart(48, 'X')}`,
    failure_destination: `GFAILURE${index.toString().padStart(48, 'X')}`,
    status: statuses[index % statuses.length],
    created_at: new Date(now.getTime() - index * 60_000),
    updated_at: new Date(now.getTime() - index * 60_000),
  }))

  await db.batchInsert('vaults', vaults, 100)
}

const seedMilestonesAndValidations = async (): Promise<void> => {
  const milestones = Array.from({ length: VAULT_COUNT }, (_, index) => ({
    id: perfMilestoneId(index),
    vault_id: perfVaultId(index),
    title: `Plan milestone ${index}`,
    description: 'Seeded milestone for query-plan benchmarks',
    target_amount: '100.0000000',
    current_amount: '50.0000000',
    deadline: new Date(now.getTime() + (index + 1) * 120_000),
    status: index % 3 === 0 ? 'completed' : 'pending',
    sort_order: 0,
    amount: '100.0000000',
    due_date: new Date(now.getTime() + (index + 1) * 120_000),
    verifier_user_id: PERF_USER_ID,
    created_at: new Date(now.getTime() - index * 60_000),
    updated_at: new Date(now.getTime() - index * 60_000),
  }))

  const validations = Array.from({ length: VAULT_COUNT }, (_, index) => ({
    id: perfValidationId(index),
    milestone_id: perfMilestoneId(index),
    validator_address: `GVALIDATOR${index.toString().padStart(46, 'X')}`,
    validation_result: index % 2 === 0 ? 'approved' : 'rejected',
    evidence_hash: `evidence-${index}`,
    validated_at: new Date(now.getTime() - index * 30_000),
    created_at: new Date(now.getTime() - index * 30_000),
  }))

  await db.batchInsert('milestones', milestones, 100)
  await db.batchInsert('validations', validations, 100)
}

const seedTransactions = async (): Promise<void> => {
  const types = ['creation', 'validation', 'release', 'redirect', 'cancel']
  const transactions = Array.from({ length: TRANSACTION_COUNT }, (_, index) => {
    const userId = index % 2 === 0 ? PERF_USER_ID : OTHER_USER_ID
    return {
      user_id: userId,
      vault_id: perfVaultId(index % VAULT_COUNT),
      tx_hash: `plan_hash_${index.toString().padStart(6, '0')}`,
      type: types[index % types.length],
      amount: String(10 + index),
      asset_code: 'XLM',
      from_account: `GFROM${index.toString().padStart(51, 'X')}`,
      to_account: `GTO${index.toString().padStart(53, 'X')}`,
      memo: `Query plan benchmark ${index}`,
      stellar_ledger: 2_000_000 + index,
      stellar_timestamp: new Date(now.getTime() - index * 30_000),
      explorer_url: `https://stellar.expert/explorer/testnet/tx/plan-${index}`,
      created_at: new Date(now.getTime() - index * 30_000),
    }
  })

  await db.batchInsert('transactions', transactions, 200)
}

const seedAnalyticsSummary = async (): Promise<void> => {
  await db('analytics_vault_summary').insert({
    id: 1,
    total_vaults: VAULT_COUNT,
    active_vaults: Math.floor(VAULT_COUNT / 5),
    completed_vaults: Math.floor(VAULT_COUNT / 5),
    failed_vaults: Math.floor(VAULT_COUNT / 5),
    total_locked_capital: '100000.0000000',
    active_capital: '20000.0000000',
    success_rate: '50.0000',
    last_updated: now,
  })
}

const explainWithSeqScanDisabled = async (
  sql: string,
  bindings: readonly Knex.RawBinding[],
): Promise<JsonPlan> =>
  db.transaction(async (trx) => {
    await trx.raw('SET LOCAL enable_seqscan = off')
    return explainQueryPlan(trx, sql, bindings)
  })

const listVaultsWithRelatedRows = async (limit: number): Promise<unknown[]> => {
  const vaultRows = await db('vaults')
    .where('organization_id', PERF_ORG_ID)
    .orderBy('created_at', 'desc')
    .limit(limit)
    .select('id', 'status', 'created_at')

  const vaultIds = vaultRows.map((vault) => vault.id)
  const milestoneRows = await db('milestones')
    .whereIn('vault_id', vaultIds)
    .select('id', 'vault_id', 'status')
  const milestoneIds = milestoneRows.map((milestone) => milestone.id)
  const validationRows = await db('validations')
    .whereIn('milestone_id', milestoneIds)
    .select('id', 'milestone_id', 'validation_result')

  return [vaultRows, milestoneRows, validationRows]
}

const listTransactionsPage = async (limit: number): Promise<unknown[]> => {
  const baseQuery = db('transactions')
    .where('user_id', PERF_USER_ID)
    .where('stellar_timestamp', '<', now)
    .orderBy('stellar_timestamp', 'desc')
    .orderBy('id', 'desc')

  const total = await baseQuery.clone().count('* as total').first()
  const rows = await baseQuery.limit(limit + 1).select('id', 'vault_id', 'stellar_timestamp')

  return [total, rows]
}

describe('query plan performance regressions', () => {
  beforeAll(async () => {
    await db.migrate.latest()
    await cleanup()
    await seedUsersAndOrg()
    await seedVaults()
    await seedMilestonesAndValidations()
    await seedTransactions()
    await seedAnalyticsSummary()
  }, 120_000)

  afterAll(async () => {
    await cleanup()
    await db.destroy()
  }, 60_000)

  it('uses the organization index for hot vault list predicates', async () => {
    const plan = await explainWithSeqScanDisabled(
      `
        SELECT id, status, created_at
        FROM vaults
        WHERE organization_id = ?
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [PERF_ORG_ID],
    )

    const summary = assertIndexedPlan(plan, {
      expectedIndexes: ['idx_vaults_organization_id'],
    })

    expect(summary.nodeTypes).not.toContain('Seq Scan')
  })

  it('uses the timestamp index for transaction cursor pagination', async () => {
    const cursorTimestamp = new Date(now.getTime() - 200 * 30_000)
    const plan = await explainWithSeqScanDisabled(
      `
        SELECT id, vault_id, stellar_timestamp
        FROM transactions
        WHERE user_id = ?
          AND stellar_timestamp < ?
        ORDER BY stellar_timestamp DESC, id DESC
        LIMIT 51
      `,
      [PERF_USER_ID, cursorTimestamp],
    )

    const summary = assertIndexedPlan(plan, {
      expectedIndexes: ['idx_transactions_stellar_timestamp'],
    })

    expect(summary.nodeTypes).not.toContain('Seq Scan')
  })

  it('uses the analytics summary primary-key plan for summary reads', async () => {
    const plan = await explainWithSeqScanDisabled(
      `
        SELECT total_vaults, active_vaults, completed_vaults, failed_vaults,
          total_locked_capital::text, active_capital::text, success_rate::float, last_updated::text
        FROM analytics_vault_summary
        WHERE id = 1
      `,
      [],
    )

    const summary = assertIndexedPlan(plan, {
      expectedIndexes: ['analytics_vault_summary_pkey'],
    })

    expect(summary.nodeTypes).not.toContain('Seq Scan')
  })

  it('keeps vault list plus nested milestones and validations query count constant', async () => {
    const smallQueryCount = await trackQueries(db, () => listVaultsWithRelatedRows(SMALL_PAGE_SIZE))
    const largeQueryCount = await trackQueries(db, () => listVaultsWithRelatedRows(LARGE_PAGE_SIZE))

    expect(smallQueryCount).toBe(3)
    expect(largeQueryCount).toBe(smallQueryCount)
    expect(largeQueryCount).toBeLessThanOrEqual(MAX_VAULT_LIST_QUERIES)
  })

  it('keeps transaction list query count constant as page size grows', async () => {
    const smallQueryCount = await trackQueries(db, () => listTransactionsPage(SMALL_PAGE_SIZE))
    const largeQueryCount = await trackQueries(db, () => listTransactionsPage(LARGE_PAGE_SIZE))

    expect(smallQueryCount).toBe(2)
    expect(largeQueryCount).toBe(smallQueryCount)
    expect(largeQueryCount).toBeLessThanOrEqual(MAX_TRANSACTION_LIST_QUERIES)
  })
})
