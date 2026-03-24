import { jest } from '@jest/globals'
import {
  getEventParserMetricsSnapshot,
  parseHorizonEvent,
  resetEventParserMetrics,
} from '../services/eventParser.js'
import {
  createMockRawHorizonEvent,
  rawEventSymbolFixtures,
} from './fixtures/horizonEvents.js'

describe('eventParser', () => {
  beforeEach(() => {
    resetEventParserMetrics()
    jest.restoreAllMocks()
  })

  describe('parseHorizonEvent', () => {
    it.each(rawEventSymbolFixtures)(
      'maps emitted symbol $symbol to parser type $eventType',
      ({ eventType, symbol }) => {
        const result = parseHorizonEvent(
          createMockRawHorizonEvent({
            id: `${eventType}-0`,
            ledger: 12345,
            topic: [symbol],
            txHash: eventType,
          }),
        )

        expect(result.success).toBe(true)
        if (result.success) {
          expect(result.event.eventType).toBe(eventType)
          expect(result.event.eventId).toBe(`${eventType}:0`)
        }
      },
    )

    it('should preserve parsed event metadata for canonical symbols', () => {
      const result = parseHorizonEvent(createMockRawHorizonEvent())

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.event.eventType).toBe('vault_created')
        expect(result.event.eventId).toBe('abc123:0')
        expect(result.event.transactionHash).toBe('abc123')
        expect(result.event.eventIndex).toBe(0)
        expect(result.event.ledgerNumber).toBe(12345)
        expect(result.event.payload).toBeDefined()
        expect((result.event.payload as any).vaultId).toBeDefined()
      }
    })

    it('should return error for unknown event type', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      const result = parseHorizonEvent(
        createMockRawHorizonEvent({
          id: 'mno345-4',
          ledger: 12349,
          topic: ['unknown_event'],
          txHash: 'mno345',
        }),
      )

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Unknown event type')
        expect(result.details).toMatchObject({
          eventId: 'mno345-4',
          ledger: 12349,
          normalizedSymbol: 'unknown_event',
          rawSymbol: 'unknown_event',
        })
      }

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('horizon_event_parser_unknown_symbol'),
      )

      const metrics = getEventParserMetricsSnapshot()
      expect(metrics.parseFailures).toBe(1)
      expect(metrics.unknownEventSymbols).toBe(1)
    })

    it('should return error for missing transaction hash', () => {
      const result = parseHorizonEvent(createMockRawHorizonEvent({ txHash: '' }))

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Missing transaction hash')
        expect(result.details).toMatchObject({
          txHashPresent: false,
        })
      }
    })

    it('should return error for missing event topic', () => {
      const result = parseHorizonEvent(createMockRawHorizonEvent({ topic: [] }))

      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error).toContain('Missing event topic')
      }
    })

    it('tracks parsed counts by canonical event type', () => {
      parseHorizonEvent(createMockRawHorizonEvent({ topic: ['vault-created'], txHash: 'tx-1' }))
      parseHorizonEvent(createMockRawHorizonEvent({ topic: ['milestoneValidated'], txHash: 'tx-2' }))

      const metrics = getEventParserMetricsSnapshot()
      expect(metrics.parsedTotal).toBe(2)
      expect(metrics.parseFailures).toBe(0)
      expect(metrics.byEventType.vault_created).toBe(1)
      expect(metrics.byEventType.milestone_validated).toBe(1)
    })
  })
})
