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
  arbitraryMilestoneCreatedEvent,
  arbitraryVaultStatus,
  arbitraryValidationResult,
  arbitraryVaultStatusEvent,
  arbitraryEventWithVaultId,
  arbitraryEventWithMilestoneId,
  arbitraryConsistentEventId,
  arbitraryVaultCompletedEvent,
  arbitraryVaultFailedEvent,
  arbitraryVaultCancelledEvent,
  arbitraryMilestoneValidatedEvent,
  arbitraryStellarAddress,
  arbitraryTransactionHash,
  arbitraryVaultId,
  arbitraryMilestoneId,
  arbitraryValidationId,
  arbitraryAmount,
  arbitraryEventId,
  arbitraryLedgerNumber,
  arbitraryEventIndex,
  arbitraryFutureDate,
  arbitraryPastDate,
  arbitraryEvidenceHash,
  arbitraryVaultCreatedPayload,
  arbitraryVaultStatusPayload,
  arbitraryMilestoneCreatedPayload,
  arbitraryValidationPayload,
  arbitraryProcessedEvent,
  arbitraryFailedEvent,
  arbitraryListenerState,
  arbitraryMilestone,
  arbitraryValidation,
  arbitraryOrganizationId,
  arbitraryTeamId,
  arbitraryUserId,
  arbitraryContractAddress,
  arbitraryHorizonUrl,
  arbitraryMilestoneStatus,
  arbitraryUniqueVaultId,
  arbitraryEventSequence,
  arbitraryVaultEventSequence,
  arbitraryEdgeCaseAmount,
  arbitraryEdgeCaseString,
  arbitrarySafeStellarAddress,
  arbitraryInvalidStatusTransition,
  setArbLogEnabled,
  logArbGeneration
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
      expect(allMockEvents.every(e => e.eventId && e.eventType)).toBe(true)
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

    it('should generate valid vault status', () => {
      fc.assert(
        fc.property(arbitraryVaultStatus(), (status: any) => {
          expect(['active', 'completed', 'failed', 'cancelled']).toContain(status)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid validation result', () => {
      fc.assert(
        fc.property(arbitraryValidationResult(), (result: any) => {
          expect(['approved', 'rejected', 'pending_review']).toContain(result)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault status events', () => {
      fc.assert(
        fc.property(arbitraryVaultStatusEvent(), (event: any) => {
          expect(['vault_completed', 'vault_failed', 'vault_cancelled']).toContain(event.eventType)
          expect(event.payload).toHaveProperty('vaultId')
          expect(event.payload).toHaveProperty('status')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate event with specific vault ID', () => {
      const testVaultId = 'test-vault-123'
      fc.assert(
        fc.property(arbitraryEventWithVaultId(testVaultId), (event: any) => {
          expect(event.payload.vaultId).toBe(testVaultId)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate event with specific milestone ID', () => {
      const testMilestoneId = 'test-milestone-456'
      fc.assert(
        fc.property(arbitraryEventWithMilestoneId(testMilestoneId), (event: any) => {
          expect(event.payload.milestoneId).toBe(testMilestoneId)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate consistent event ID from transaction hash and index', () => {
      fc.assert(
        fc.property(arbitraryConsistentEventId(), (result: any) => {
          expect(result.eventId).toBe(`${result.transactionHash}:${result.eventIndex}`)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault completed events', () => {
      fc.assert(
        fc.property(arbitraryVaultCompletedEvent(), (event: any) => {
          expect(event.eventType).toBe('vault_completed')
          expect(event.payload.status).toBe('completed')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault failed events', () => {
      fc.assert(
        fc.property(arbitraryVaultFailedEvent(), (event: any) => {
          expect(event.eventType).toBe('vault_failed')
          expect(event.payload.status).toBe('failed')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault cancelled events', () => {
      fc.assert(
        fc.property(arbitraryVaultCancelledEvent(), (event: any) => {
          expect(event.eventType).toBe('vault_cancelled')
          expect(event.payload.status).toBe('cancelled')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid milestone validated events', () => {
      fc.assert(
        fc.property(arbitraryMilestoneValidatedEvent(), (event: any) => {
          expect(event.eventType).toBe('milestone_validated')
          expect(event.payload).toHaveProperty('validationId')
          expect(event.payload).toHaveProperty('milestoneId')
          expect(event.payload).toHaveProperty('validatorAddress')
          expect(['approved', 'rejected', 'pending_review']).toContain(event.payload.validationResult)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid Stellar addresses', () => {
      fc.assert(
        fc.property(arbitraryStellarAddress(), (addr: string) => {
          expect(addr).toMatch(/^G[A-Z0-9]{55}$/)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid transaction hashes', () => {
      fc.assert(
        fc.property(arbitraryTransactionHash(), (hash: string) => {
          expect(hash).toMatch(/^[a-f0-9]{64}$/)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault IDs', () => {
      fc.assert(
        fc.property(arbitraryVaultId(), (id: string) => {
          expect(id).toMatch(/^vault-/)
          expect(id.length).toBeGreaterThanOrEqual(10)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid milestone IDs', () => {
      fc.assert(
        fc.property(arbitraryMilestoneId(), (id: string) => {
          expect(id).toMatch(/^milestone-/)
          expect(id.length).toBeGreaterThanOrEqual(10)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid validation IDs', () => {
      fc.assert(
        fc.property(arbitraryValidationId(), (id: string) => {
          expect(id).toMatch(/^validation-/)
          expect(id.length).toBeGreaterThanOrEqual(10)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid amounts', () => {
      fc.assert(
        fc.property(arbitraryAmount(), (amount: string) => {
          expect(amount).toMatch(/^\d+\.\d{7}$/)
          expect(parseFloat(amount)).toBeGreaterThan(0)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid event IDs', () => {
      fc.assert(
        fc.property(arbitraryEventId(), (id: string) => {
          const parts = id.split(':')
          expect(parts).toHaveLength(2)
          expect(parts[0]).toMatch(/^[a-f0-9]{64}$/)
          expect(parseInt(parts[1], 10)).toBeGreaterThanOrEqual(0)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid ledger numbers', () => {
      fc.assert(
        fc.property(arbitraryLedgerNumber(), (num: number) => {
          expect(num).toBeGreaterThan(0)
          expect(num).toBeLessThanOrEqual(10000000)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid event indices', () => {
      fc.assert(
        fc.property(arbitraryEventIndex(), (idx: number) => {
          expect(idx).toBeGreaterThanOrEqual(0)
          expect(idx).toBeLessThanOrEqual(100)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid future dates', () => {
      fc.assert(
        fc.property(arbitraryFutureDate(), (date: Date) => {
          expect(date.getTime()).toBeGreaterThan(Date.now())
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid past dates', () => {
      fc.assert(
        fc.property(arbitraryPastDate(), (date: Date) => {
          expect(date.getTime()).toBeLessThanOrEqual(Date.now())
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid evidence hashes', () => {
      fc.assert(
        fc.property(arbitraryEvidenceHash(), (hash: string) => {
          expect(hash).toMatch(/^hash-/)
          expect(hash.length).toBeGreaterThanOrEqual(37)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault created payloads', () => {
      fc.assert(
        fc.property(arbitraryVaultCreatedPayload(), (payload: any) => {
          expect(payload).toHaveProperty('vaultId')
          expect(payload).toHaveProperty('creator')
          expect(payload).toHaveProperty('amount')
          expect(payload).toHaveProperty('status')
          expect(payload.status).toBe('active')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault status payloads', () => {
      fc.assert(
        fc.property(arbitraryVaultStatusPayload('completed'), (payload: any) => {
          expect(payload).toHaveProperty('vaultId')
          expect(payload).toHaveProperty('status')
          expect(payload.status).toBe('completed')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid milestone created payloads', () => {
      fc.assert(
        fc.property(arbitraryMilestoneCreatedPayload(), (payload: any) => {
          expect(payload).toHaveProperty('milestoneId')
          expect(payload).toHaveProperty('vaultId')
          expect(payload).toHaveProperty('title')
          expect(payload).toHaveProperty('targetAmount')
          expect(payload).toHaveProperty('deadline')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid validation payloads', () => {
      fc.assert(
        fc.property(arbitraryValidationPayload(), (payload: any) => {
          expect(payload).toHaveProperty('validationId')
          expect(payload).toHaveProperty('milestoneId')
          expect(payload).toHaveProperty('validatorAddress')
          expect(payload).toHaveProperty('validationResult')
          expect(payload).toHaveProperty('evidenceHash')
          expect(payload).toHaveProperty('validatedAt')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid ProcessedEvent', () => {
      fc.assert(
        fc.property(arbitraryProcessedEvent(), (event: any) => {
          expect(event).toHaveProperty('eventId')
          expect(event).toHaveProperty('transactionHash')
          expect(event).toHaveProperty('eventIndex')
          expect(event).toHaveProperty('ledgerNumber')
          expect(event).toHaveProperty('processedAt')
          expect(event).toHaveProperty('createdAt')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid FailedEvent', () => {
      fc.assert(
        fc.property(arbitraryFailedEvent(), (event: any) => {
          expect(event).toHaveProperty('id')
          expect(event).toHaveProperty('eventId')
          expect(event).toHaveProperty('eventPayload')
          expect(event).toHaveProperty('errorMessage')
          expect(event).toHaveProperty('retryCount')
          expect(event.retryCount).toBeGreaterThanOrEqual(0)
          expect(event.retryCount).toBeLessThanOrEqual(5)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid ListenerState', () => {
      fc.assert(
        fc.property(arbitraryListenerState(), (state: any) => {
          expect(state).toHaveProperty('id')
          expect(state).toHaveProperty('serviceName')
          expect(state).toHaveProperty('lastProcessedLedger')
          expect(state).toHaveProperty('lastProcessedAt')
          expect(state).toHaveProperty('createdAt')
          expect(state).toHaveProperty('updatedAt')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid Milestone entity', () => {
      fc.assert(
        fc.property(arbitraryMilestone(), (milestone: any) => {
          expect(milestone).toHaveProperty('id')
          expect(milestone).toHaveProperty('vaultId')
          expect(milestone).toHaveProperty('title')
          expect(milestone).toHaveProperty('targetAmount')
          expect(milestone).toHaveProperty('currentAmount')
          expect(milestone).toHaveProperty('deadline')
          expect(milestone).toHaveProperty('status')
          expect(['pending', 'in_progress', 'completed', 'failed']).toContain(milestone.status)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid Validation entity', () => {
      fc.assert(
        fc.property(arbitraryValidation(), (validation: any) => {
          expect(validation).toHaveProperty('id')
          expect(validation).toHaveProperty('milestoneId')
          expect(validation).toHaveProperty('validatorAddress')
          expect(validation).toHaveProperty('validationResult')
          expect(validation).toHaveProperty('validatedAt')
          expect(validation).toHaveProperty('createdAt')
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid organization ID', () => {
      fc.assert(
        fc.property(arbitraryOrganizationId(), (id: string) => {
          expect(id).toMatch(/^org-/)
          expect(id.length).toBeGreaterThanOrEqual(14)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid team ID', () => {
      fc.assert(
        fc.property(arbitraryTeamId(), (id: string) => {
          expect(id).toMatch(/^team-/)
          expect(id.length).toBeGreaterThanOrEqual(15)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid user ID', () => {
      fc.assert(
        fc.property(arbitraryUserId(), (id: string) => {
          expect(id).toMatch(/^user-/)
          expect(id.length).toBeGreaterThanOrEqual(15)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid contract addresses', () => {
      fc.assert(
        fc.property(arbitraryContractAddress(), (addr: string) => {
          expect(addr).toMatch(/^C[A-Z0-9]{54}$/)
          expect(addr.length).toBe(55)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid Horizon URLs', () => {
      fc.assert(
        fc.property(arbitraryHorizonUrl(), (url: string) => {
          expect(url).toMatch(/^https?:\/\//)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid milestone statuses', () => {
      fc.assert(
        fc.property(arbitraryMilestoneStatus(), (status: string) => {
          expect(['pending', 'in_progress', 'completed', 'failed']).toContain(status)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid event sequences', () => {
      fc.assert(
        fc.property(arbitraryEventSequence(2, 5), (events: any[]) => {
          expect(events.length).toBeGreaterThanOrEqual(2)
          expect(events.length).toBeLessThanOrEqual(5)
          events.forEach(e => {
            expect(e).toHaveProperty('eventId')
            expect(e).toHaveProperty('eventType')
          })
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid vault event sequences', () => {
      fc.assert(
        fc.property(arbitraryVaultEventSequence(), (seq: any) => {
          expect(seq.created.eventType).toBe('vault_created')
          expect(seq.completed.eventType).toBe('vault_completed')
          expect(seq.milestones.length).toBeGreaterThanOrEqual(1)
          expect(seq.milestones.length).toBeLessThanOrEqual(5)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate edge case amounts', () => {
      fc.assert(
        fc.property(arbitraryEdgeCaseAmount(), (amount: string) => {
          expect(amount).toMatch(/^\d+\.\d{7}$/)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate safe Stellar addresses without special chars', () => {
      fc.assert(
        fc.property(arbitrarySafeStellarAddress(), (addr: string) => {
          expect(addr).toMatch(/^G[A-Z0-9]+$/)
        }),
        { numRuns: 10 }
      )
    })

    it('should generate valid status transitions with validity flag', () => {
      fc.assert(
        fc.property(arbitraryInvalidStatusTransition(), (trans: any) => {
          expect(trans).toHaveProperty('fromStatus')
          expect(trans).toHaveProperty('toStatus')
          expect(trans).toHaveProperty('isValid')
        }),
        { numRuns: 10 }
      )
    })

    it('should enable arb logging when configured', () => {
      setArbLogEnabled(true)
      expect(() => setArbLogEnabled(false)).not.toThrow()
    })

    it('should log arb generation when enabled', () => {
      setArbLogEnabled(true)
      expect(() => logArbGeneration('test', 10)).not.toThrow()
      setArbLogEnabled(false)
    })
  })
})
