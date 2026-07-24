import type { Knex } from 'knex'
import { beforeAll, beforeEach, afterAll, describe, expect, it } from '@jest/globals'
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
  createMockMilestoneCreatedEvent,
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

  it('moves retryable dependency failures into failed_events after retries are exhausted', async () => {
    const fastProcessor = new EventProcessor(db, { maxRetries: 2, retryBackoffMs: 1 })
    const missingVaultEvent = createMockMilestoneCreatedEvent({
      eventId: 'dlq-missing-vault:0',
      transactionHash: 'dlq-missing-vault',
      payload: {
        milestoneId: 'milestone-dlq-001',
        vaultId: 'missing-vault',
        title: 'DLQ milestone',
        description: 'This event should be dead-lettered',
        targetAmount: '100.0000000',
        deadline: new Date('2024-06-30T23:59:59Z')
      }
    })

    const result = await fastProcessor.processEvent(missingVaultEvent)

    expect(result).toMatchObject({
      success: false,
      eventId: missingVaultEvent.eventId,
      retryCount: 2
    })
    expect(result.error).toContain('Vault not found for milestone')

    const failedEvent = await db('failed_events').where({ event_id: missingVaultEvent.eventId }).first()
    expect(failedEvent).toBeDefined()
    expect(failedEvent.error_message).toContain('Vault not found for milestone')
    expect(failedEvent.retry_count).toBe(2)
    expect(failedEvent.event_payload).toMatchObject({
      eventId: missingVaultEvent.eventId,
      transactionHash: missingVaultEvent.transactionHash,
      eventType: 'milestone_created',
      payload: {
        vaultId: 'missing-vault',
        milestoneId: 'milestone-dlq-001'
      }
    })

    const processedEvent = await db('processed_events').where({ event_id: missingVaultEvent.eventId }).first()
    expect(processedEvent).toBeUndefined()
  })

  it('updates the existing failed_events row when the same event fails again', async () => {
    const fastProcessor = new EventProcessor(db, { maxRetries: 1, retryBackoffMs: 1 })
    const missingVaultEvent = createMockMilestoneCreatedEvent({
      eventId: 'dlq-repeat:0',
      transactionHash: 'dlq-repeat',
      payload: {
        milestoneId: 'milestone-dlq-repeat',
        vaultId: 'missing-vault',
        title: 'DLQ repeat',
        description: 'This event should update one dead-letter row',
        targetAmount: '100.0000000',
        deadline: new Date('2024-06-30T23:59:59Z')
      }
    })

    await fastProcessor.processEvent(missingVaultEvent)
    await fastProcessor.processEvent(missingVaultEvent)

    const failedRows = await db('failed_events').where({ event_id: missingVaultEvent.eventId })
    expect(failedRows).toHaveLength(1)
    expect(failedRows[0].retry_count).toBe(1)
  })

  it('reprocesses a failed event and removes it from the dead-letter queue on success', async () => {
    await insertTestVault(db, 'vault-test-001', { status: 'active' })
    await db('failed_events').insert({
      event_id: mockVaultCompletedEvent.eventId,
      event_payload: JSON.stringify(mockVaultCompletedEvent),
      error_message: 'previous transient failure',
      retry_count: 3,
      failed_at: new Date(),
      created_at: new Date()
    })

    const result = await processor.reprocessFailedEvent(mockVaultCompletedEvent.eventId)

    expect(result.success).toBe(true)
    const vault = await db('vaults').where({ id: 'vault-test-001' }).first()
    expect(vault.status).toBe('completed')
    const failedEvent = await db('failed_events').where({ event_id: mockVaultCompletedEvent.eventId }).first()
    expect(failedEvent).toBeUndefined()
  })

  it('parses raw Horizon events into parsed events using the {txHash}:{eventIndex} id format', () => {
    const rawEvent = createRawHorizonEvent(
      'vault_completed',
      { vaultId: 'vault-test-002', status: 'completed' },
      { txHash: 'txhash123', id: 'txhash123-7' }
    )

    const result = parseHorizonEvent(rawEvent)
    expect(result.success).toBe(true)
    if (!result.success) {
      throw new Error('Expected raw Horizon event to parse')
    }
    expect(result.event.eventId).toBe('txhash123:7')
    expect(result.event.eventType).toBe('vault_completed')
    expect(result.event.payload).toMatchObject({ vaultId: 'vault-test-002', status: 'completed' })
  })
})
