// Must run before any module that reads DATABASE_URL at load time.
import './helpers/useTestDatabaseUrl.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { createRequire } from 'node:module'
import type { Knex } from 'knex'
import { setupTestDatabase, teardownTestDatabase } from './helpers/testDatabase.js'
import { runExpirationCheck } from '../services/expirationScheduler.js'
import { createSettlementOperation } from '../services/settlementOperations.js'
import { createDefaultJobHandlers } from '../jobs/handlers.js'
import {
  defaultSorobanClient,
  resetSorobanConfig,
  setSorobanClient,
} from '../services/soroban.js'
import type { EmbeddingReindexDependencies } from '../jobs/handlers.js'

const vaultIds = {
  expired: 'expiry-settlement-expired',
  future: 'expiry-settlement-future',
  verified: 'expiry-settlement-verified',
  concurrent: 'expiry-settlement-concurrent',
}

// Needs a real Postgres (CI provides TEST_DATABASE_URL); skip otherwise.
const hasTestDatabase = Boolean(process.env.TEST_DATABASE_URL)
const describeDb = hasTestDatabase ? describe : describe.skip

let testDb: Knex
const submitSlashMock = jest.fn<(...args: unknown[]) => Promise<{ txHash: string }>>()
const handlers = createDefaultJobHandlers(
  { send: async () => undefined },
  {} as EmbeddingReindexDependencies,
)

const insertVault = async (
  id: string,
  endDate: Date,
  status = 'active',
): Promise<void> => {
  await testDb('vaults').insert({
    id,
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: '1000.0000000',
    start_date: new Date('2020-01-01T00:00:00Z'),
    end_date: endDate,
    verifier: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status,
  })
}

const insertMilestone = async (id: string, vaultId: string, status: string): Promise<void> => {
  await testDb('milestones').insert({
    id,
    vault_id: vaultId,
    title: 'Expiry settlement test',
    description: 'Test milestone',
    target_amount: '1000.0000000',
    current_amount: '0',
    amount: '1000.0000000',
    deadline: new Date('2020-06-01T00:00:00Z'),
    status,
  })
}

const runSettlementJob = async (): Promise<void> => {
  const settlementHandler = handlers['settlement.process']
  if (!settlementHandler) throw new Error('settlement.process handler was not registered')
  await settlementHandler({ batchSize: 20 }, { jobId: 'expiry-settlement-test', attempt: 1 })
}

beforeAll(async () => {
  if (!hasTestDatabase) return
  testDb = await setupTestDatabase()
  process.env.SOROBAN_CONTRACT_ID = 'C'.repeat(56)
  process.env.SOROBAN_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015'
  process.env.SOROBAN_SOURCE_ACCOUNT = 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX'
  process.env.SOROBAN_RPC_URL = 'http://localhost:8000'
  process.env.SOROBAN_SECRET_KEY = 'S'.repeat(56)
  resetSorobanConfig()
  setSorobanClient({
    ...defaultSorobanClient,
    submitSlash: submitSlashMock,
  })
})

beforeEach(async () => {
  if (!hasTestDatabase) return
  delete process.env.DRY_RUN
  submitSlashMock.mockReset()
  submitSlashMock.mockResolvedValue({ txHash: 'expiryTxHash123456789' })
  await testDb('settlement_operations').delete()
  await testDb('milestones').delete()
  await testDb('vaults').delete()
  await testDb('scheduler_heartbeats').where({ name: 'expiration_scheduler' }).delete()
})

afterAll(async () => {
  resetSorobanConfig()
  if (testDb) await teardownTestDatabase(testDb)
})

describeDb('expired vault settlement ledger', () => {
  it('marks expired unverified vaults and creates one pending redirect, leaving future and verified vaults alone', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-expired', vaultIds.expired, 'pending')
    await insertVault(vaultIds.future, new Date('2999-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-future', vaultIds.future, 'pending')
    await insertVault(vaultIds.verified, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-verified', vaultIds.verified, 'approved')

    await runExpirationCheck()

    const vaultRows = await testDb('vaults').select('id', 'status')
    expect(vaultRows.find((row) => row.id === vaultIds.expired)?.status).toBe('failed')
    expect(vaultRows.find((row) => row.id === vaultIds.future)?.status).toBe('active')
    expect(vaultRows.find((row) => row.id === vaultIds.verified)?.status).toBe('active')
    const operations = await testDb('settlement_operations').where({ vault_id: vaultIds.expired })
    expect(operations).toHaveLength(1)
    expect(operations[0]).toMatchObject({
      status: 'pending',
      operation_type: 'redirect',
      operation_key: `slash_on_miss:${vaultIds.expired}`,
      target_milestone_id: 'expiry-settlement-ms-expired',
    })
  })

  it('does not create duplicate operations for concurrent scheduler ticks', async () => {
    await insertVault(vaultIds.concurrent, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-concurrent', vaultIds.concurrent, 'pending')

    await Promise.all([runExpirationCheck(), runExpirationCheck()])

    const operations = await testDb('settlement_operations').where({ vault_id: vaultIds.concurrent })
    expect(operations).toHaveLength(1)
  })

  it('submits, records the transaction hash, and confirms a pending settlement', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-success', vaultIds.expired, 'pending')
    await runExpirationCheck()

    await runSettlementJob()

    const [operation] = await testDb('settlement_operations').where({ vault_id: vaultIds.expired })
    expect(submitSlashMock).toHaveBeenCalledWith(expect.anything(), {
      vaultId: vaultIds.expired,
      milestoneId: 'expiry-settlement-ms-success',
    })

    expect(operation).toMatchObject({
      status: 'confirmed',
      transaction_hash: 'expiryTxHash123456789',
      attempt_count: 1,
    })
  })

  it('recovers a pending operation committed before the worker ran', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'), 'failed')
    await insertMilestone('expiry-settlement-ms-crash', vaultIds.expired, 'pending')
    const operation = await createSettlementOperation({
      vaultId: vaultIds.expired,
      targetMilestoneId: 'expiry-settlement-ms-crash',
      operationKey: `slash_on_miss:${vaultIds.expired}`,
      operationType: 'redirect',
      requestedBy: 'expiry-settlement-test',
      destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '1000.0000000',
    })

    await runSettlementJob()

    const recovered = await testDb('settlement_operations').where({ id: operation.id }).first()
    expect(submitSlashMock).toHaveBeenCalledTimes(1)
    expect(recovered).toMatchObject({ status: 'confirmed', attempt_count: 1 })
  })

  it('permanently fails contract rejections without changing the vault status again', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-contract', vaultIds.expired, 'pending')
    await runExpirationCheck()
    submitSlashMock.mockRejectedValueOnce(new Error('ContractError: Disputed'))

    await runSettlementJob()

    const operation = await testDb('settlement_operations').where({ vault_id: vaultIds.expired }).first()
    const vault = await testDb('vaults').where({ id: vaultIds.expired }).first()
    expect(operation).toMatchObject({ status: 'failed', failure_code: 'CONTRACT_REJECTED', attempt_count: 1 })
    expect(vault.status).toBe('failed')
  })

  it('retains transient network failures for retry and leaves directly inserted pending rows recoverable', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-network', vaultIds.expired, 'pending')
    await runExpirationCheck()
    submitSlashMock.mockRejectedValueOnce(new Error('connection reset'))

    await runSettlementJob()
    let operation = await testDb('settlement_operations').where({ vault_id: vaultIds.expired }).first()
    expect(operation).toMatchObject({ status: 'pending', attempt_count: 1, failure_code: 'NETWORK_ERROR' })

    submitSlashMock.mockResolvedValueOnce({ txHash: 'expiryTxHash987654321' })
    await runSettlementJob()
    operation = await testDb('settlement_operations').where({ vault_id: vaultIds.expired }).first()
    expect(operation).toMatchObject({ status: 'confirmed', attempt_count: 2 })
  })

  it('does not submit pending operations in dry-run mode', async () => {
    await insertVault(vaultIds.expired, new Date('2020-02-01T00:00:00Z'))
    await insertMilestone('expiry-settlement-ms-dry', vaultIds.expired, 'pending')
    await runExpirationCheck()
    process.env.DRY_RUN = 'true'

    await runSettlementJob()

    expect(submitSlashMock).not.toHaveBeenCalled()
    const operation = await testDb('settlement_operations').where({ vault_id: vaultIds.expired }).first()
    expect(operation.status).toBe('pending')
  })

  it('supports rolling the vault-scope migration down and back up', async () => {
    const migration = createRequire(import.meta.url)(
      '../../db/migrations/20261018210000_add_vault_scope_to_settlement_operations.cjs',
    )
    await migration.down(testDb)
    await migration.up(testDb)
    const hasVaultId = await testDb.schema.hasColumn('settlement_operations', 'vault_id')
    expect(hasVaultId).toBe(true)
  })
})
