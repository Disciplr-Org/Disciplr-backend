import fc from 'fast-check'
import {
  ParsedEvent,
  EventType,
  VaultEventPayload,
  MilestoneEventPayload,
  ValidationEventPayload
} from '../../types/horizonSync'

/**
 * Fast-check arbitraries for property-based testing
 * These generators create random valid events for testing universal properties
 */

// Generate a valid Stellar address (56 characters starting with G)
export const arbitraryStellarAddress = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 55, maxLength: 55 }).map(s => 'G' + s.toUpperCase())

// Generate a valid transaction hash (64 character hex string)
export const arbitraryTransactionHash = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 64, maxLength: 64 }).map(s => 
    s.split('').map(c => '0123456789abcdef'[Math.abs(c.charCodeAt(0)) % 16]).join('')
  )

// Generate a valid vault ID
export const arbitraryVaultId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `vault-${s}`)

// Generate a valid milestone ID
export const arbitraryMilestoneId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `milestone-${s}`)

// Generate a valid validation ID
export const arbitraryValidationId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `validation-${s}`)

// Generate a valid amount (decimal with 7 decimal places)
export const arbitraryAmount = (): fc.Arbitrary<string> =>
  fc.double({ min: 0.0000001, max: 1000000, noNaN: true }).map(n => n.toFixed(7))

// Generate a valid event ID in format {transaction_hash}:{event_index}
export const arbitraryEventId = (): fc.Arbitrary<string> =>
  fc.tuple(arbitraryTransactionHash(), fc.integer({ min: 0, max: 100 }))
    .map(([hash, index]) => `${hash}:${index}`)

// Generate a valid ledger number
export const arbitraryLedgerNumber = (): fc.Arbitrary<number> =>
  fc.integer({ min: 1, max: 10000000 })

// Generate a valid event index
export const arbitraryEventIndex = (): fc.Arbitrary<number> =>
  fc.integer({ min: 0, max: 100 })

// Generate a future date (for deadlines and end timestamps)
export const arbitraryFutureDate = (): fc.Arbitrary<Date> =>
  fc.date({ min: new Date(), max: new Date('2030-12-31') })

// Generate a past or present date (for start timestamps and validated_at)
export const arbitraryPastDate = (): fc.Arbitrary<Date> =>
  fc.date({ min: new Date('2020-01-01'), max: new Date() })

// Generate a valid vault status
export const arbitraryVaultStatus = (): fc.Arbitrary<'active' | 'completed' | 'failed' | 'cancelled'> =>
  fc.constantFrom('active', 'completed', 'failed', 'cancelled')

// Generate a valid validation result
export const arbitraryValidationResult = (): fc.Arbitrary<'approved' | 'rejected' | 'pending_review'> =>
  fc.constantFrom('approved', 'rejected', 'pending_review')

// Generate a valid evidence hash
export const arbitraryEvidenceHash = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 32, maxLength: 64 }).map(s => 
    `hash-${s.split('').map(c => '0123456789abcdef'[Math.abs(c.charCodeAt(0)) % 16]).join('')}`
  )

// Generate a vault_created event payload
export const arbitraryVaultCreatedPayload = (): fc.Arbitrary<VaultEventPayload> =>
  fc.record({
    vaultId: arbitraryVaultId(),
    creator: arbitraryStellarAddress(),
    amount: arbitraryAmount(),
    startTimestamp: arbitraryPastDate(),
    endTimestamp: arbitraryFutureDate(),
    successDestination: arbitraryStellarAddress(),
    failureDestination: arbitraryStellarAddress(),
    status: fc.constant('active' as const)
  })

// Generate a vault status change event payload (completed, failed, cancelled)
export const arbitraryVaultStatusPayload = (
  status: 'completed' | 'failed' | 'cancelled'
): fc.Arbitrary<VaultEventPayload> =>
  fc.record({
    vaultId: arbitraryVaultId(),
    status: fc.constant(status)
  })

// Generate a milestone_created event payload
export const arbitraryMilestoneCreatedPayload = (): fc.Arbitrary<MilestoneEventPayload> =>
  fc.record({
    milestoneId: arbitraryMilestoneId(),
    vaultId: arbitraryVaultId(),
    title: fc.string({ minLength: 1, maxLength: 255 }),
    description: fc.string({ minLength: 0, maxLength: 1000 }),
    targetAmount: arbitraryAmount(),
    deadline: arbitraryFutureDate()
  })

// Generate a milestone_validated event payload
export const arbitraryValidationPayload = (): fc.Arbitrary<ValidationEventPayload> =>
  fc.record({
    validationId: arbitraryValidationId(),
    milestoneId: arbitraryMilestoneId(),
    validatorAddress: arbitraryStellarAddress(),
    validationResult: arbitraryValidationResult(),
    evidenceHash: arbitraryEvidenceHash(),
    validatedAt: arbitraryPastDate()
  })

// Generate a vault_created event
export const arbitraryVaultCreatedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('vault_created' as const),
    payload: arbitraryVaultCreatedPayload()
  })

// Generate a vault_completed event
export const arbitraryVaultCompletedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('vault_completed' as const),
    payload: arbitraryVaultStatusPayload('completed')
  })

// Generate a vault_failed event
export const arbitraryVaultFailedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('vault_failed' as const),
    payload: arbitraryVaultStatusPayload('failed')
  })

// Generate a vault_cancelled event
export const arbitraryVaultCancelledEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('vault_cancelled' as const),
    payload: arbitraryVaultStatusPayload('cancelled')
  })

// Generate a milestone_created event
export const arbitraryMilestoneCreatedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('milestone_created' as const),
    payload: arbitraryMilestoneCreatedPayload()
  })

// Generate a milestone_validated event
export const arbitraryMilestoneValidatedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    eventType: fc.constant('milestone_validated' as const),
    payload: arbitraryValidationPayload()
  })

// Generate any valid parsed event (union of all event types)
export const arbitraryParsedEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.oneof(
    arbitraryVaultCreatedEvent(),
    arbitraryVaultCompletedEvent(),
    arbitraryVaultFailedEvent(),
    arbitraryVaultCancelledEvent(),
    arbitraryMilestoneCreatedEvent(),
    arbitraryMilestoneValidatedEvent()
  )

// Generate a vault status event (completed, failed, or cancelled)
export const arbitraryVaultStatusEvent = (): fc.Arbitrary<ParsedEvent> =>
  fc.oneof(
    arbitraryVaultCompletedEvent(),
    arbitraryVaultFailedEvent(),
    arbitraryVaultCancelledEvent()
  )

// Generate an event with a specific vault ID (useful for testing related events)
export const arbitraryEventWithVaultId = (vaultId: string): fc.Arbitrary<ParsedEvent> =>
  fc.oneof(
    arbitraryVaultCreatedEvent().map(e => ({
      ...e,
      payload: { ...e.payload, vaultId }
    })),
    arbitraryVaultStatusEvent().map(e => ({
      ...e,
      payload: { ...e.payload, vaultId }
    })),
    arbitraryMilestoneCreatedEvent().map(e => ({
      ...e,
      payload: { ...e.payload, vaultId }
    }))
  )

// Generate an event with a specific milestone ID (useful for testing validations)
export const arbitraryEventWithMilestoneId = (milestoneId: string): fc.Arbitrary<ParsedEvent> =>
  arbitraryMilestoneValidatedEvent().map(e => ({
    ...e,
    payload: { ...e.payload, milestoneId }
  }))

// Generate a consistent event ID from transaction hash and event index
export const arbitraryConsistentEventId = (): fc.Arbitrary<{
  eventId: string
  transactionHash: string
  eventIndex: number
}> =>
  fc.tuple(arbitraryTransactionHash(), arbitraryEventIndex()).map(([hash, index]) => ({
    eventId: `${hash}:${index}`,
    transactionHash: hash,
    eventIndex: index
  }))
