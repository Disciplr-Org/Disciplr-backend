import { jest } from '@jest/globals'
import { HorizonListener } from '../services/horizonListener.js'
import { CheckpointStore } from '../services/checkpointStore.js'
import { HorizonListenerConfig } from '../config/horizonListener.js'
import { HorizonEvent } from '../services/eventParser.js'
import { createRawHorizonEvent } from './fixtures/horizonEvents.js'
import { HorizonCheckpoint } from '../types/horizonSync.js'

const CONTRACT_ID = 'CTEST123'
const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

function makeVaultCreatedEvent(
  ledger: number,
  txHash: string,
  eventIndex: number,
  overrides: Partial<HorizonEvent> = {},
): HorizonEvent {
  return createRawHorizonEvent(
    'vault_created',
    {
      vaultId: VALID_UUID,
      creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '1000.0000000',
      startTimestamp: new Date('2024-01-01T00:00:00Z'),
      endTimestamp: new Date('2024-12-31T23:59:59Z'),
      successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    },
    {
      ledger,
      contractId: CONTRACT_ID,
      txHash,
      id: `${txHash}-${eventIndex}`,
      pagingToken: `${ledger}-${eventIndex}`,
      ...overrides,
    },
  )
}

function makeCheckpoint(lastLedger: number, pagingToken: string): HorizonCheckpoint {
  return {
    id: 1,
    contractAddress: CONTRACT_ID,
    lastLedger,
    lastPagingToken: pagingToken,
    updatedAt: new Date(),
    createdAt: new Date(),
  }
}

function createMockDb(): any {
  return {} as any
}

function createMockEventProcessor(success = true): any {
  return {
    processEvent: jest.fn<any>().mockResolvedValue(
      success
        ? { success: true, eventId: 'test-event' }
        : { success: false, eventId: 'test-event', error: 'Intentional failure' },
    ),
  }
}

function createMockCheckpointStore(): any {
  return {
    getCheckpoint: jest.fn<any>().mockResolvedValue(null),
    upsertCheckpoint: jest.fn<any>().mockResolvedValue(undefined),
  }
}

const baseConfig: HorizonListenerConfig = {
  horizonUrl: 'https://horizon-testnet.stellar.org',
  contractAddresses: [CONTRACT_ID],
  startLedger: 1000,
  retryMaxAttempts: 3,
  retryBackoffMs: 100,
  shutdownTimeoutMs: 30000,
  lagThreshold: 30,
}

// ── Contract verified by these tests ───────────────────────────────────────
//
// HorizonListener.handleEvent() provides at-least-once delivery with no
// duplicate side-effects when paired with EventProcessor idempotency.
// Specifically:
//
//  1. Every event accepted by handleEvent() is forwarded to
//     EventProcessor.processEvent(), even if the ledger duplicates a
//     previously-seen event.  Deduplication happens inside EventProcessor
//     via the processed_events idempotency table, not in the listener.
//
//  2. After a successful processEvent() the listener persists a per-contract
//     checkpoint (contract_id, last_ledger, paging_token) via
//     CheckpointStore.upsertCheckpoint().  There is no monotonicity check on
//     the checkpoint write — out-of-order delivery can move the cursor
//     backward.
//
//  3. On (re)start, loadEffectiveStartLedger() queries each contract's
//     checkpoint and returns the MINIMUM lastLedger across all configured
//     contracts.  This guarantees that a contract lagging behind its peers
//     receives all its missed events.  If a checkpoint was moved backward
//     (see #2), the listener will resume from the lower ledger and
//     re-deliver events; idempotency absorbs the duplicates.
//
//  4. Events from non-configured contracts, parse failures, and processing
//     failures do not advance the checkpoint.

describe('HorizonListener — chaos tests (resume / dedupe / reorder)', () => {
  let mockDb: any
  let mockEventProcessor: any
  let mockCheckpointStore: any
  let config: HorizonListenerConfig

  beforeEach(() => {
    mockDb = createMockDb()
    mockEventProcessor = createMockEventProcessor(true)
    mockCheckpointStore = createMockCheckpointStore()
    config = { ...baseConfig }
  })

  // ── Resume after mid-stream error ─────────────────────────────────────

  describe('resume from persisted cursor after interruption', () => {
    it('persists checkpoint for every successfully processed event', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1001, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1002, 'tx2', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx3', 0))

      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenCalledTimes(3)
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenNthCalledWith(1, CONTRACT_ID, 1001, '1001-0')
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenNthCalledWith(2, CONTRACT_ID, 1002, '1002-0')
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenNthCalledWith(3, CONTRACT_ID, 1003, '1003-0')
    })

    it('loads effective start ledger from persisted checkpoint, not startLedger', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1001, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1002, 'tx2', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx3', 0))

      mockCheckpointStore.getCheckpoint.mockResolvedValue(makeCheckpoint(1003, '1003-0'))

      const newListener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)
      const startLedger = await newListener.loadEffectiveStartLedger()

      expect(startLedger).toBe(1003)
    })

    it('falls back to startLedger when no checkpoint exists', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)
      const startLedger = await listener.loadEffectiveStartLedger()

      expect(startLedger).toBe(1000)
    })

    it('recovers from checkpoint write failure without crashing', async () => {
      mockCheckpointStore.upsertCheckpoint.mockRejectedValue(new Error('DB write failed'))

      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await expect(
        listener.handleEvent(makeVaultCreatedEvent(1001, 'tx1', 0)),
      ).resolves.toBeUndefined()

      expect(mockEventProcessor.processEvent).toHaveBeenCalledTimes(1)
    })

    it('uses minimum checkpoint across multiple contracts', async () => {
      const multiConfig: HorizonListenerConfig = {
        ...config,
        contractAddresses: ['CA', 'CB', 'CC'],
      }
      const store = createMockCheckpointStore()
      store.getCheckpoint.mockImplementation(async (addr: string) => {
        const map: Record<string, number> = { CA: 1050, CB: 1020, CC: 1100 }
        return makeCheckpoint(map[addr] ?? 1000, `${map[addr] ?? 1000}-0`)
      })

      const listener = new HorizonListener(multiConfig, mockEventProcessor, mockDb, store)
      const startLedger = await listener.loadEffectiveStartLedger()

      expect(startLedger).toBe(1020)
    })
  })

  // ── Duplicate ledger replay ───────────────────────────────────────────

  describe('duplicate ledger replay deduplication', () => {
    it('forwards duplicate events to EventProcessor (idempotency lives there)', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)
      const event = makeVaultCreatedEvent(1005, 'tx1', 0)

      await listener.handleEvent(event)
      await listener.handleEvent(event)

      expect(mockEventProcessor.processEvent).toHaveBeenCalledTimes(2)
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenCalledTimes(2)
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenNthCalledWith(1, CONTRACT_ID, 1005, '1005-0')
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenNthCalledWith(2, CONTRACT_ID, 1005, '1005-0')
    })

    it('same ledger, different events (different txHashes) are both processed', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx2', 0))

      expect(mockEventProcessor.processEvent).toHaveBeenCalledTimes(2)
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenCalledTimes(2)
    })
  })

  // ── Out-of-order / backward ledger delivery ───────────────────────────

  describe('out-of-order ledger handling', () => {
    it('processes events regardless of ledger arrival order', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx2', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1007, 'tx3', 0))

      expect(mockEventProcessor.processEvent).toHaveBeenCalledTimes(3)
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenCalledTimes(3)
    })

    it('checkpoint reflects each event ledger even when moving backward', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenLastCalledWith(CONTRACT_ID, 1005, '1005-0')

      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx2', 0))
      expect(mockCheckpointStore.upsertCheckpoint).toHaveBeenLastCalledWith(CONTRACT_ID, 1003, '1003-0')
    })

    it('restart from backward checkpoint re-delivers ledgers idempotency absorbs', async () => {
      const store = createMockCheckpointStore()
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, store)

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx2', 0))

      store.getCheckpoint.mockResolvedValue(makeCheckpoint(1003, '1003-0'))

      const restarted = new HorizonListener(config, mockEventProcessor, mockDb, store)
      const resumedFrom = await restarted.loadEffectiveStartLedger()

      expect(resumedFrom).toBe(1003)
    })

    it('monotonic delivery advances cursor strictly', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1001, 'tx1', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1002, 'tx2', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1003, 'tx3', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1004, 'tx4', 0))
      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx5', 0))

      const calls = mockCheckpointStore.upsertCheckpoint.mock.calls as [string, number, string][]
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i][1]).toBeGreaterThan(calls[i - 1][1])
      }
    })
  })

  // ── Event filtering ───────────────────────────────────────────────────

  describe('event filtering and edge cases', () => {
    it('ignores events from non-configured contracts', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      const event = makeVaultCreatedEvent(1005, 'tx1', 0, {
        contractId: 'UNKNOWN_CONTRACT',
      })

      await listener.handleEvent(event)

      expect(mockEventProcessor.processEvent).not.toHaveBeenCalled()
      expect(mockCheckpointStore.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('handles parse failures gracefully — no checkpoint written', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      const event = createRawHorizonEvent(
        'vault_created',
        { invalid: true },
        {
          ledger: 1005,
          contractId: CONTRACT_ID,
          txHash: 'tx1',
          id: 'tx1-0',
          pagingToken: '1005-0',
        },
      )

      await listener.handleEvent(event)

      expect(mockEventProcessor.processEvent).not.toHaveBeenCalled()
      expect(mockCheckpointStore.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('does not persist checkpoint when processing fails', async () => {
      const failingProcessor = createMockEventProcessor(false)
      const listener = new HorizonListener(config, failingProcessor, mockDb, mockCheckpointStore)

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))

      expect(failingProcessor.processEvent).toHaveBeenCalledTimes(1)
      expect(mockCheckpointStore.upsertCheckpoint).not.toHaveBeenCalled()
    })

    it('skips event processing during shutdown', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      const startPromise = listener.start()
      await new Promise(resolve => setTimeout(resolve, 50))
      await listener.stop()

      await listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))

      expect(mockEventProcessor.processEvent).not.toHaveBeenCalled()
      expect(mockCheckpointStore.upsertCheckpoint).not.toHaveBeenCalled()

      await startPromise
    })

    it('tracks inFlightEvents correctly', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)

      let resolveProcessor!: () => void
      const processorPromise = new Promise<void>(resolve => { resolveProcessor = resolve })
      mockEventProcessor.processEvent.mockImplementation(() => processorPromise.then(() => ({ success: true, eventId: 'test-event' })))

      const handlePromise = listener.handleEvent(makeVaultCreatedEvent(1005, 'tx1', 0))

      // Give the microtask queue a tick so handleEvent increments inFlightEvents
      await new Promise(resolve => setImmediate(resolve))

      expect((listener as any).inFlightEvents).toBe(1)

      resolveProcessor()
      await handlePromise

      expect((listener as any).inFlightEvents).toBe(0)
    })
  })

  // ── Idempotency boundary / EventProcessor contract ────────────────────

  describe('contract: EventProcessor receives correct parsed events', () => {
    it('passes the parsed event to EventProcessor.processEvent', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb, mockCheckpointStore)
      const rawEvent = makeVaultCreatedEvent(1005, 'tx1', 0)

      await listener.handleEvent(rawEvent)

      const [parsedEvent] = mockEventProcessor.processEvent.mock.calls[0]
      expect(parsedEvent).toMatchObject({
        transactionHash: 'tx1',
        ledgerNumber: 1005,
        eventType: 'vault_created',
      })
    })
  })
})
