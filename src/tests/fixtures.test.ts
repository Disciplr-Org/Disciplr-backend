import { describe, it, expect } from '@jest/globals'
import {
  mockVaultCreatedEvent,
  mockMilestoneCreatedEvent,
  mockMilestoneValidatedEvent,
  allMockEvents,
  createMockVaultCreatedEvent
} from './fixtures/horizonEvents.js'
import {
  arbitraryParsedEvent,
  arbitraryVaultCreatedEvent,
  arbitraryMilestoneCreatedEvent
} from './fixtures/arbitraries.js'
import fc from 'fast-check'

describe('Test Fixtures and Helpers', () => {
  describe('Horizon Event Fixtures', () => {
    it('should have valid mock vault created event', () => {
      expect(mockVaultCreatedEvent.eventType).toBe('vault_created')
      expect(mockVaultCreatedEvent.eventId).toMatch(/^[a-f0-9]+:\d+$/)
      expect(mockVaultCreatedEvent.payload).toHaveProperty('vaultId')
      expect(mockVaultCreatedEvent.payload).toHaveProperty('creator')
      expect(mockVaultCreatedEvent.payload).toHaveProperty('amount')
    })

    it('should have valid mock milestone created event', () => {
      expect(mockMilestoneCreatedEvent.eventType).toBe('milestone_created')
      expect(mockMilestoneCreatedEvent.payload).toHaveProperty('milestoneId')
      expect(mockMilestoneCreatedEvent.payload).toHaveProperty('vaultId')
      expect(mockMilestoneCreatedEvent.payload).toHaveProperty('title')
    })

    it('should have valid mock milestone validated event', () => {
      expect(mockMilestoneValidatedEvent.eventType).toBe('milestone_validated')
      expect(mockMilestoneValidatedEvent.payload).toHaveProperty('validationId')
      expect(mockMilestoneValidatedEvent.payload).toHaveProperty('milestoneId')
      expect(mockMilestoneValidatedEvent.payload).toHaveProperty('validatorAddress')
    })

    it('should have all mock events in collection', () => {
      expect(allMockEvents.length).toBeGreaterThan(0)
      expect(allMockEvents.every((e: any) => e.eventId && e.eventType)).toBe(true)
    })

    it('should create custom vault event with overrides', () => {
      const customEvent = createMockVaultCreatedEvent({
        eventId: 'custom-id:0',
        payload: { vaultId: 'custom-vault-id' }
      })
      expect(customEvent.eventId).toBe('custom-id:0')
      expect((customEvent.payload as any).vaultId).toBe('custom-vault-id')
    })
  })

  describe('Fast-check Arbitraries', () => {
    it('should generate valid parsed events', () => {
      fc.assert(
        fc.property(arbitraryParsedEvent(), (event: any) => {
          expect(event).toHaveProperty('eventId')
          expect(event).toHaveProperty('transactionHash')
          expect(event).toHaveProperty('eventIndex')
          expect(event).toHaveProperty('ledgerNumber')
          expect(event).toHaveProperty('eventType')
          expect(event).toHaveProperty('payload')
          expect(event.eventIndex).toBeGreaterThanOrEqual(0)
          expect(event.ledgerNumber).toBeGreaterThan(0)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault created events', () => {
      fc.assert(
        fc.property(arbitraryVaultCreatedEvent(), (event: any) => {
          expect(event.eventType).toBe('vault_created')
          expect(event.payload).toHaveProperty('vaultId')
          expect(event.payload).toHaveProperty('creator')
          expect(event.payload).toHaveProperty('amount')
          expect(event.payload.status).toBe('active')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid milestone created events', () => {
      fc.assert(
        fc.property(arbitraryMilestoneCreatedEvent(), (event: any) => {
          expect(event.eventType).toBe('milestone_created')
          expect(event.payload).toHaveProperty('milestoneId')
          expect(event.payload).toHaveProperty('vaultId')
          expect(event.payload).toHaveProperty('title')
          expect(event.payload).toHaveProperty('targetAmount')
        }),
        { numRuns: 10 }
      )
    })
  })
})
