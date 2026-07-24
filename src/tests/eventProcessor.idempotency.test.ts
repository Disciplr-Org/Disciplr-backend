import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import type { Knex } from 'knex'
import type { ParsedEvent } from '../types/horizonSync.js'
import { EventProcessor } from '../services/eventProcessor.js'
import {
  setupTestDatabase,
  teardownTestDatabase,
  cleanAllTables,
  captureDbState,
  compareDbStates,
  isEventProcessed,
} from './helpers/testDatabase.js'
import {
  mockVaultCreatedEvent,
  mockMilestoneCreatedEvent,
  mockMilestoneValidatedEvent,
  createMockVaultCreatedEvent,
} from './fixtures/horizonEvents.js'

describe('EventProcessor idempotency replay', () => {
  let db: Knex | undefined
  let processor: EventProcessor

  const getDb = (): Knex => {
    if (!db) {
      throw new Error('Test database was not initialized')
    }

    return db
  }

  beforeAll(async () => {
    db = await setupTestDatabase()
    processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 50 })
  })

  afterAll(async () => {
    if (db) {
      await teardownTestDatabase(db)
    }
  })

  beforeEach(async () => {
    await cleanAllTables(getDb())
  })

  it('records processed event metadata after the first successful delivery', async () => {
    const result = await processor.processEvent(mockVaultCreatedEvent)

    expect(result.success).toBe(true)
    expect(await isEventProcessed(getDb(), mockVaultCreatedEvent.eventId)).toBe(true)

    const processedEvent = await getDb()('processed_events')
      .where({ event_id: mockVaultCreatedEvent.eventId })
      .first()

    expect(processedEvent).toBeDefined()
    expect(processedEvent.transaction_hash).toBe(mockVaultCreatedEvent.transactionHash)
    expect(processedEvent.event_index).toBe(mockVaultCreatedEvent.eventIndex)
    expect(processedEvent.ledger_number).toBe(mockVaultCreatedEvent.ledgerNumber)
    expect(processedEvent.processed_at).toBeTruthy()
  })

  it('skips a duplicate event_id without changing committed rows', async () => {
    await processor.processEvent(mockVaultCreatedEvent)
    const beforeReplay = await captureDbState(getDb())

    const replayResult = await processor.processEvent(mockVaultCreatedEvent)
    const afterReplay = await captureDbState(getDb())

    expect(replayResult.success).toBe(true)
    expect(replayResult.eventId).toBe(mockVaultCreatedEvent.eventId)
    expect(compareDbStates(beforeReplay, afterReplay)).toBe(true)
  })

  it('keeps full vault milestone validation sequence replay as a no-op', async () => {
    const sequence: ParsedEvent[] = [
      mockVaultCreatedEvent,
      mockMilestoneCreatedEvent,
      mockMilestoneValidatedEvent,
    ]

    for (const event of sequence) {
      await expect(processor.processEvent(event)).resolves.toMatchObject({
        success: true,
        eventId: event.eventId,
      })
    }

    const beforeReplay = await captureDbState(getDb())

    for (const event of sequence) {
      await expect(processor.processEvent(event)).resolves.toMatchObject({
        success: true,
        eventId: event.eventId,
      })
    }

    const afterReplay = await captureDbState(getDb())
    expect(compareDbStates(beforeReplay, afterReplay)).toBe(true)
    expect(afterReplay.vaults).toHaveLength(1)
    expect(afterReplay.milestones).toHaveLength(1)
    expect(afterReplay.validations).toHaveLength(1)
    expect(afterReplay.processedEvents).toHaveLength(sequence.length)
  })

  it('treats the same transaction hash with different event indexes as distinct events', async () => {
    const firstEvent = createMockVaultCreatedEvent({
      eventId: 'same-transaction:0',
      transactionHash: 'same-transaction',
      eventIndex: 0,
      payload: {
        ...mockVaultCreatedEvent.payload,
        vaultId: 'vault-same-transaction-0',
      },
    })
    const secondEvent = createMockVaultCreatedEvent({
      eventId: 'same-transaction:1',
      transactionHash: 'same-transaction',
      eventIndex: 1,
      payload: {
        ...mockVaultCreatedEvent.payload,
        vaultId: 'vault-same-transaction-1',
      },
    })

    await expect(processor.processEvent(firstEvent)).resolves.toMatchObject({
      success: true,
      eventId: firstEvent.eventId,
    })
    await expect(processor.processEvent(secondEvent)).resolves.toMatchObject({
      success: true,
      eventId: secondEvent.eventId,
    })

    const vaultIds = await getDb()('vaults').pluck('id').orderBy('id')
    const processedEvents = await getDb()('processed_events')
      .select('event_id', 'transaction_hash', 'event_index')
      .orderBy('event_index')

    expect(vaultIds).toEqual(['vault-same-transaction-0', 'vault-same-transaction-1'])
    expect(processedEvents).toEqual([
      {
        event_id: firstEvent.eventId,
        transaction_hash: 'same-transaction',
        event_index: 0,
      },
      {
        event_id: secondEvent.eventId,
        transaction_hash: 'same-transaction',
        event_index: 1,
      },
    ])
  })
})
