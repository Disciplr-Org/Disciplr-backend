import type { Knex } from 'knex'
import { EventProcessor } from '../services/eventProcessor.js'
import { parseHorizonEvent } from '../services/eventParser.js'
import {
  setupTestDatabase,
  teardownTestDatabase,
  cleanAllTables,
  insertTestVault,
  insertTestMilestone,
  captureDbState,
} from './helpers/testDatabase.js'
import {
  mockVaultCompletedEvent,
  mockMilestoneValidatedEvent,
  createRawHorizonEvent,
} from './fixtures/horizonEvents.js'

describe('EventProcessor Horizon event mapping', () => {
  let db: Knex
  let processor: EventProcessor

  beforeAll(async () => {
    db = await setupTestDatabase()
    processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 50 })
  })

  afterAll(async () => {
    await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    await cleanAllTables(db)
  })

  it('processes vault_completed events through transitional status update and records the processed event', async () => {
    await insertTestVault(db, 'vault-test-001', { status: 'active' })

    const result = await processor.processEvent(mockVaultCompletedEvent)

    expect(result.success).toBe(true)
    expect(result.eventId).toBe(mockVaultCompletedEvent.eventId)

    const vault = await db('vaults').where({ id: 'vault-test-001' }).first()
    expect(vault).toBeDefined()
    expect(vault.status).toBe('completed')

    const processedEvent = await db('processed_events').where({ event_id: mockVaultCompletedEvent.eventId }).first()
    expect(processedEvent).toBeDefined()
    expect(processedEvent.transaction_hash).toBe(mockVaultCompletedEvent.transactionHash)
  })

  it('applies milestone_validated events and updates milestone status for approved validations', async () => {
    await insertTestVault(db, 'vault-test-001', { status: 'active' })
    await insertTestMilestone(db, 'milestone-test-001', 'vault-test-001', {
      targetAmount: '500.0000000',
      currentAmount: '0',
      status: 'pending'
    })

    const result = await processor.processEvent(mockMilestoneValidatedEvent)

    expect(result.success).toBe(true)

    const validation = await db('validations').where({ id: 'validation-test-001' }).first()
    expect(validation).toBeDefined()
    expect(validation.milestone_id).toBe('milestone-test-001')
    expect(validation.validation_result).toBe('approved')
    expect(validation.validator_address).toBe('GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX')

    const milestone = await db('milestones').where({ id: 'milestone-test-001' }).first()
    expect(milestone).toBeDefined()
    expect(milestone.status).toBe('completed')
    expect(milestone.current_amount).toBe('500.0000000')
  })

  it('skips already processed events and preserves database state', async () => {
    await insertTestVault(db, 'vault-test-001', { status: 'active' })

    await processor.processEvent(mockVaultCompletedEvent)
    const beforeState = await captureDbState(db)

    const secondResult = await processor.processEvent(mockVaultCompletedEvent)
    expect(secondResult.success).toBe(true)
    expect(secondResult.eventId).toBe(mockVaultCompletedEvent.eventId)

    const afterState = await captureDbState(db)
    expect(afterState).toEqual(beforeState)
  })

  it('parses raw Horizon events into parsed events using the {txHash}:{eventIndex} id format', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_completed',
      { vaultId: 'vault-test-002', status: 'completed' },
      { txHash: 'txhash123', id: 'txhash123-7' }
    )

    const result = parseHorizonEvent(rawEvent)
    expect(result.success).toBe(true)
    expect(result.event.eventId).toBe('txhash123:7')
    expect(result.event.eventType).toBe('vault_completed')
    expect(result.event.payload).toMatchObject({ vaultId: 'vault-test-002', status: 'completed' })
  })
})
