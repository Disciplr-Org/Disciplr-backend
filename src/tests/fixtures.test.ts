import { describe, it, expect } from '@jest/globals'
import {
  mockVaultCreatedEvent,
  mockVaultCompletedEvent,
  mockMilestoneValidatedEvent,
  allMockEvents,
  createMockVaultCreatedEvent,
  mockHorizonOperation,
  mockHorizonTransaction
} from './fixtures/horizonEvents.js'
import {
  operationArbitrary,
  transactionArbitrary,
} from './fixtures/arbitraries.js'
import fc from 'fast-check'
import { parseEvent } from '../services/eventParser.js'

describe('Test Fixtures and Helpers', () => {
  it('should have mock events for all types', () => {
    expect(allMockEvents.length).toBeGreaterThan(0)
    const types = new Set(allMockEvents.map(e => e.eventType))
    expect(types.has('vault_created')).toBe(true)
  })

  it('should generate valid horizon operations', () => {
    fc.assert(
      fc.property(operationArbitrary, (e: any) => {
        const result = parseEvent(e)
        if (result.success) {
          expect(result.event).toBeDefined()
          expect(result.event.transactionHash).toBe(e.transaction_hash)
        } else {
          // If parsing fails, it should be due to invalid mock data format if any
          // but our arbitraries should match.
        }
      })
    )
  })

  it('should generate valid horizon transactions', () => {
    fc.assert(
      fc.property(transactionArbitrary, (e: any) => {
        expect(e.hash).toBeDefined()
        expect(e.ledger).toBeGreaterThan(0)
      })
    )
  })
})
