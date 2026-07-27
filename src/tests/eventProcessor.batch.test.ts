import { describe, it, expect, beforeAll, afterAll, beforeEach, jest } from '@jest/globals'
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
  insertTestVault,
  insertTestMilestone,
} from './helpers/testDatabase.js'
import {
  mockVaultCreatedEvent,
  mockVaultCompletedEvent,
  mockMilestoneCreatedEvent,
  mockMilestoneValidatedEvent,
  createMockVaultCreatedEvent,
  createMockMilestoneCreatedEvent,
  createMockValidationEvent,
} from './fixtures/horizonEvents.js'

describe('EventProcessor batch processing', () => {
  let db: Knex | undefined
  let processor: EventProcessor

  const getDb = (): Knex => {
    if (!db) throw new Error('Test database was not initialized')
    return db
  }

  beforeAll(async () => {
    db = await setupTestDatabase()
    processor = new EventProcessor(db, { maxRetries: 3, retryBackoffMs: 50, batchSize: 10 })
  })

  afterAll(async () => {
    if (db) await teardownTestDatabase(db)
  })

  beforeEach(async () => {
    await cleanAllTables(getDb())
  })

  describe('basic batch processing', () => {
    it('processes a batch of unique events and records all as processed', async () => {
      const events: ParsedEvent[] = [
        mockVaultCreatedEvent,
        mockVaultCompletedEvent,
      ]

      // Ensure vault exists for completed event
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      const result = await processor.processBatch(events)

      expect(result.total).toBe(2)
      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.results).toHaveLength(2)
      expect(result.results.every(r => r.success)).toBe(true)

      for (const event of events) {
        expect(await isEventProcessed(getDb(), event.eventId)).toBe(true)
      }

      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('returns configurable batch size', () => {
      expect(processor.getBatchSize()).toBe(10)
    })

    it('defaults batch size to 50 when not configured', () => {
      const defaultProcessor = new EventProcessor(getDb(), { maxRetries: 3, retryBackoffMs: 50 })
      expect(defaultProcessor.getBatchSize()).toBe(50)
    })
  })

  describe('batch deduplication', () => {
    it('skips events already processed in a previous batch (cross-batch duplicate)', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      // First batch
      const firstResult = await processor.processBatch([mockVaultCreatedEvent, mockVaultCompletedEvent])
      expect(firstResult.succeeded).toBe(2)

      const beforeSecond = await captureDbState(getDb())

      // Second batch with overlap
      const secondResult = await processor.processBatch([
        mockVaultCreatedEvent,
        mockVaultCompletedEvent,
      ])

      expect(secondResult.total).toBe(2)
      expect(secondResult.succeeded).toBe(0)
      expect(secondResult.skipped).toBe(2)
      expect(secondResult.failed).toBe(0)

      const afterSecond = await captureDbState(getDb())
      expect(compareDbStates(beforeSecond, afterSecond)).toBe(true)
    })

    it('handles mixed batch with both new and already-processed events', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })
      const secondVaultEvent = createMockVaultCreatedEvent({
        eventId: 'second-vault:0',
        transactionHash: 'second-vault',
        payload: {
          vaultId: 'vault-test-002',
          creator: 'GCREATOR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          amount: '500.0000000',
          startTimestamp: new Date('2024-06-01T00:00:00Z'),
          endTimestamp: new Date('2024-12-31T00:00:00Z'),
          successDestination: 'GSUCCESS2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          failureDestination: 'GFAILURE2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          status: 'active',
        },
      })

      await processor.processBatch([mockVaultCreatedEvent])

      const result = await processor.processBatch([mockVaultCreatedEvent, secondVaultEvent])

      expect(result.total).toBe(2)
      expect(result.skipped).toBe(1)
      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(0)

      expect(await isEventProcessed(getDb(), secondVaultEvent.eventId)).toBe(true)
    })

    it('deduplicates when the same event appears twice within a single batch', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      const result = await processor.processBatch([
        mockVaultCreatedEvent,
        mockVaultCreatedEvent,
      ])

      // Second occurrence should be skipped by dedupe (it's already in processed_events after first)
      expect(result.total).toBe(2)
      expect(result.skipped).toBe(1)
      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(0)

      // Only one row in processed_events
      const processedRows = await getDb()('processed_events')
        .where({ event_id: mockVaultCreatedEvent.eventId })
      expect(processedRows).toHaveLength(1)
    })
  })

  describe('crash mid-batch / no double-apply', () => {
    it('does not double-apply events on retry if the batch transaction was rolled back', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      // Simulate a mid-batch failure — capture state before any batch
      const stateBefore = await captureDbState(getDb())

      // Create a processor that will throw mid-batch
      const failingProcessor = new EventProcessor(getDb(), { maxRetries: 0, retryBackoffMs: 1, batchSize: 5 })

      const originalRouteEvent = (failingProcessor as any).routeEvent.bind(failingProcessor)
      let callCount = 0
      jest.spyOn(failingProcessor as any, 'routeEvent').mockImplementation(
        async (event: ParsedEvent, trx: Knex.Transaction) => {
          callCount++
          if (callCount === 2) {
            throw new Error('Simulated mid-batch crash')
          }
          return originalRouteEvent(event, trx)
        }
      )

      await expect(
        failingProcessor.processBatch([mockVaultCreatedEvent, mockVaultCompletedEvent])
      ).resolves.toMatchObject({
        total: 2,
        failed: expect.any(Number),
      })

      // The transaction was rolled back — no changes should be committed
      const stateAfter = await captureDbState(getDb())
      expect(compareDbStates(stateBefore, stateAfter)).toBe(true)

      // No processed_events rows should exist (transaction rolled back)
      const processedRows = await getDb()('processed_events').select()
      expect(processedRows).toHaveLength(0)
    })

    it('can retry a failed batch successfully (idempotent replay)', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      const tempProcessor = new EventProcessor(getDb(), { maxRetries: 0, retryBackoffMs: 1, batchSize: 10 })

      const originalRoute = (tempProcessor as any).routeEvent.bind(tempProcessor)
      let failOnce = false
      jest.spyOn(tempProcessor as any, 'routeEvent').mockImplementation(
        async (event: ParsedEvent, trx: Knex.Transaction) => {
          if (!failOnce && event.eventId === mockVaultCompletedEvent.eventId) {
            failOnce = true
            throw new Error('Transient failure')
          }
          return originalRoute(event, trx)
        }
      )

      // First attempt — fails mid-batch
      await tempProcessor.processBatch([mockVaultCreatedEvent, mockVaultCompletedEvent])

      // Nothing committed (transaction rolled back)
      const vaultsCount = await getDb()('vaults').select().then(r => r.length)
      expect(vaultsCount).toBe(0)

      // Retry with a clean processor
      const retryResult = await processor.processBatch([
        mockVaultCreatedEvent,
        mockVaultCompletedEvent,
      ])

      expect(retryResult.succeeded).toBe(2)
      expect(await isEventProcessed(getDb(), mockVaultCreatedEvent.eventId)).toBe(true)
      expect(await isEventProcessed(getDb(), mockVaultCompletedEvent.eventId)).toBe(true)

      const vault = await getDb()('vaults').where({ id: 'vault-test-001' }).first()
      expect(vault).toBeDefined()
      expect(vault.status).toBe('completed')
    })
  })

  describe('per-vault ordering', () => {
    it('maintains ledger order for events within the same vault', async () => {
      const vaultId = 'vault-ordering-test'

      const orderEvents: ParsedEvent[] = [
        createMockVaultCreatedEvent({
          eventId: 'ordering:0',
          transactionHash: 'ordering-0',
          eventIndex: 0,
          ledgerNumber: 100,
          payload: {
            vaultId,
            creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            amount: '1000.0000000',
            startTimestamp: new Date('2024-01-01T00:00:00Z'),
            endTimestamp: new Date('2024-12-31T00:00:00Z'),
            successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            status: 'active',
          },
        }),
        createMockValidationEvent({
          eventId: 'ordering:1',
          transactionHash: 'ordering-1',
          eventIndex: 0,
          ledgerNumber: 101,
          payload: {
            validationId: 'val-ordering-001',
            milestoneId: 'milestone-ordering-001',
            validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            validationResult: 'approved',
            evidenceHash: 'hash-ordering-001',
            validatedAt: new Date('2024-06-15T10:30:00Z'),
          },
        }),
      ]

      // Insert vault and milestone for the validation event
      await getDb()('vaults').insert({
        id: vaultId,
        creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        amount: '1000.0000000',
        start_timestamp: new Date('2024-01-01'),
        end_timestamp: new Date('2024-12-31'),
        success_destination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        failure_destination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        status: 'active',
        created_at: new Date(),
      })
      await getDb()('milestones').insert({
        id: 'milestone-ordering-001',
        vault_id: vaultId,
        title: 'Ordering Milestone',
        description: 'Test ordering',
        target_amount: '500.0000000',
        current_amount: '0',
        deadline: new Date('2024-06-30'),
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date(),
      })

      const result = await processor.processBatch(orderEvents)

      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(0)

      const vault = await getDb()('vaults').where({ id: vaultId }).first()
      expect(vault.status).toBe('active')

      const milestone = await getDb()('milestones').where({ id: 'milestone-ordering-001' }).first()
      expect(milestone.status).toBe('completed')
    })

    it('processes events for multiple vaults in vault order within the batch', async () => {
      const events: ParsedEvent[] = []
      const vaultCount = 3

      for (let i = 0; i < vaultCount; i++) {
        const vaultId = `vault-multi-${String.fromCharCode(65 + i)}`
        events.push(createMockVaultCreatedEvent({
          eventId: `multi-${i}:0`,
          transactionHash: `multi-${i}`,
          eventIndex: 0,
          ledgerNumber: 1000 + i,
          payload: {
            vaultId,
            creator: `GCREATOR${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`,
            amount: `${(i + 1) * 100}.0000000`,
            startTimestamp: new Date('2024-01-01T00:00:00Z'),
            endTimestamp: new Date('2024-12-31T00:00:00Z'),
            successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            status: 'active',
          },
        }))
      }

      const result = await processor.processBatch(events)

      expect(result.succeeded).toBe(vaultCount)
      expect(result.failed).toBe(0)

      for (const event of events) {
        const vaultPayload = event.payload as any
        expect(await isEventProcessed(getDb(), event.eventId)).toBe(true)
        const vault = await getDb()('vaults').where({ id: vaultPayload.vaultId }).first()
        expect(vault).toBeDefined()
      }
    })
  })

  describe('throughput metric', () => {
    it('exposes throughput metric on successful batch', async () => {
      await insertTestVault(getDb(), 'vault-test-001', { status: 'active' })

      const result = await processor.processBatch([mockVaultCreatedEvent, mockVaultCompletedEvent])

      expect(result.total).toBe(2)
      expect(result.succeeded).toBe(2)
      expect(result.durationMs).toBeGreaterThan(0)
    })
  })

  describe('edge cases', () => {
    it('handles an empty batch gracefully', async () => {
      const result = await processor.processBatch([])

      expect(result.total).toBe(0)
      expect(result.succeeded).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.skipped).toBe(0)
      expect(result.results).toHaveLength(0)
      expect(result.durationMs).toBeGreaterThanOrEqual(0)
    })

    it('processes mixed event types in a single batch (vault, milestone, validation)', async () => {
      const vaultId = 'vault-mixed-batch'

      // Pre-create vault for milestone
      await insertTestVault(getDb(), vaultId, { status: 'active' })
      await insertTestMilestone(getDb(), 'milestone-mixed-batch', vaultId, {
        targetAmount: '500.0000000',
        currentAmount: '0',
        status: 'pending',
      })

      const mixedEvents: ParsedEvent[] = [
        mockVaultCompletedEvent,
        mockMilestoneValidatedEvent,
      ]

      const result = await processor.processBatch(mixedEvents)

      expect(result.succeeded).toBe(2)
      expect(result.failed).toBe(0)

      const vault = await getDb()('vaults').where({ id: 'vault-test-001' }).first()
      expect(vault.status).toBe('completed')

      const milestone = await getDb()('milestones').where({ id: 'milestone-test-001' }).first()
      expect(milestone.status).toBe('completed')

      const validation = await getDb()('validations').where({ id: 'validation-test-001' }).first()
      expect(validation).toBeDefined()
    })

    it('reports individual event failures within a batch without affecting other events', async () => {
      const brokenEvent = createMockMilestoneCreatedEvent({
        eventId: 'broken-dep:0',
        transactionHash: 'broken-dep',
        payload: {
          milestoneId: 'milestone-broken',
          vaultId: 'non-existent-vault',
          title: 'Broken milestone',
          description: 'This should fail',
          targetAmount: '100.0000000',
          deadline: new Date('2024-06-30T23:59:59Z'),
        },
      })

      const result = await processor.processBatch([mockVaultCreatedEvent, brokenEvent])

      expect(result.succeeded).toBe(1)
      expect(result.failed).toBe(1)
      expect(result.skipped).toBe(0)
      expect(result.total).toBe(2)

      // vault_created succeeded
      expect(result.results[0].success).toBe(true)
      expect(await isEventProcessed(getDb(), mockVaultCreatedEvent.eventId)).toBe(true)

      // milestone_created failed
      expect(result.results[1].success).toBe(false)
      expect(result.results[1].error).toContain('Vault not found for milestone')
    })

    it('handles a large batch of events without error', async () => {
      const eventCount = 25
      const events: ParsedEvent[] = []

      for (let i = 0; i < eventCount; i++) {
        const vaultId = `vault-bulk-${i}`
        events.push(createMockVaultCreatedEvent({
          eventId: `bulk-${i}:0`,
          transactionHash: `bulk-${i}`,
          eventIndex: 0,
          ledgerNumber: 2000 + i,
          payload: {
            vaultId,
            creator: `GCREATOR${i}XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX`,
            amount: `${(i + 1) * 10}.0000000`,
            startTimestamp: new Date('2024-01-01T00:00:00Z'),
            endTimestamp: new Date('2024-12-31T00:00:00Z'),
            successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            status: 'active',
          },
        }))
      }

      const result = await processor.processBatch(events)

      expect(result.total).toBe(eventCount)
      expect(result.succeeded).toBe(eventCount)
      expect(result.failed).toBe(0)
      expect(result.results).toHaveLength(eventCount)

      const processedCount = await getDb()('processed_events').select().then(r => r.length)
      expect(processedCount).toBe(eventCount)

      const vaultCount = await getDb()('vaults').select().then(r => r.length)
      expect(vaultCount).toBe(eventCount)
    })

    it('processes events with the same transaction hash but different indexes', async () => {
      const events: ParsedEvent[] = [
        createMockVaultCreatedEvent({
          eventId: 'same-tx:0',
          transactionHash: 'same-tx-hash',
          eventIndex: 0,
          payload: {
            vaultId: 'vault-same-tx-1',
            creator: 'GCREATOR1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            amount: '100.0000000',
            startTimestamp: new Date('2024-01-01T00:00:00Z'),
            endTimestamp: new Date('2024-06-30T00:00:00Z'),
            successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            status: 'active',
          },
        }),
        createMockVaultCreatedEvent({
          eventId: 'same-tx:1',
          transactionHash: 'same-tx-hash',
          eventIndex: 1,
          payload: {
            vaultId: 'vault-same-tx-2',
            creator: 'GCREATOR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            amount: '200.0000000',
            startTimestamp: new Date('2024-01-01T00:00:00Z'),
            endTimestamp: new Date('2024-12-31T00:00:00Z'),
            successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
            status: 'active',
          },
        }),
      ]

      const result = await processor.processBatch(events)

      expect(result.succeeded).toBe(2)

      const processedEvents = await getDb()('processed_events')
        .select('event_id', 'transaction_hash', 'event_index')
        .orderBy('event_index')

      expect(processedEvents).toEqual([
        { event_id: 'same-tx:0', transaction_hash: 'same-tx-hash', event_index: 0 },
        { event_id: 'same-tx:1', transaction_hash: 'same-tx-hash', event_index: 1 },
      ])
    })
  })
})
