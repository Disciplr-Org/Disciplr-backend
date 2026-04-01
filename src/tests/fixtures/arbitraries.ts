import fc from 'fast-check'
import {
  ParsedEvent,
  VaultEventPayload,
  MilestoneEventPayload,
  ValidationEventPayload
} from '../../types/horizonSync.js'

let arbLoggingEnabled = false

export const setArbLogEnabled = (enabled: boolean) => {
  arbLoggingEnabled = enabled
  if (enabled && process.env.NODE_ENV !== 'test') {
    console.log('[arbitraries] Logging enabled')
  }
}

export const logArbGeneration = (arbName: string, numRuns: number) => {
  if (arbLoggingEnabled && process.env.NODE_ENV !== 'test') {
    console.log(`[arbitraries] Generated ${numRuns} samples for ${arbName}`)
  }
}

// Generate a valid Stellar address (56 characters starting with G)
export const arbitraryStellarAddress = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 55, maxLength: 55 }).map(s => 
    'G' + s.split('').map(c => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.abs(c.charCodeAt(0)) % 36]).join('')
  )

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

// Generate a ProcessedEvent
export const arbitraryProcessedEvent = (): fc.Arbitrary<ProcessedEvent> =>
  fc.record({
    eventId: arbitraryEventId(),
    transactionHash: arbitraryTransactionHash(),
    eventIndex: arbitraryEventIndex(),
    ledgerNumber: arbitraryLedgerNumber(),
    processedAt: arbitraryPastDate(),
    createdAt: arbitraryPastDate()
  })

// Generate a FailedEvent
export const arbitraryFailedEvent = (): fc.Arbitrary<FailedEvent> =>
  fc.record({
    id: fc.integer({ min: 1, max: 100000 }),
    eventId: arbitraryEventId(),
    eventPayload: arbitraryParsedEvent(),
    errorMessage: fc.string({ minLength: 1, maxLength: 500 }),
    retryCount: fc.integer({ min: 0, max: 5 }),
    failedAt: arbitraryPastDate(),
    createdAt: arbitraryPastDate()
  })

// Generate a ListenerState
export const arbitraryListenerState = (): fc.Arbitrary<ListenerState> =>
  fc.record({
    id: fc.integer({ min: 1, max: 1000 }),
    serviceName: fc.string({ minLength: 1, maxLength: 100 }),
    lastProcessedLedger: arbitraryLedgerNumber(),
    lastProcessedAt: arbitraryPastDate(),
    createdAt: arbitraryPastDate(),
    updatedAt: arbitraryPastDate()
  })

// Generate a Milestone (database entity)
export const arbitraryMilestone = (): fc.Arbitrary<Milestone> =>
  fc.record({
    id: arbitraryMilestoneId(),
    vaultId: arbitraryVaultId(),
    title: fc.string({ minLength: 1, maxLength: 255 }),
    description: fc.option(fc.string({ minLength: 0, maxLength: 1000 })),
    targetAmount: arbitraryAmount(),
    currentAmount: arbitraryAmount(),
    deadline: arbitraryFutureDate(),
    status: fc.constantFrom('pending', 'in_progress', 'completed', 'failed'),
    createdAt: arbitraryPastDate(),
    updatedAt: arbitraryPastDate()
  })

// Generate a Validation (database entity)
export const arbitraryValidation = (): fc.Arbitrary<Validation> =>
  fc.record({
    id: arbitraryValidationId(),
    milestoneId: arbitraryMilestoneId(),
    validatorAddress: arbitraryStellarAddress(),
    validationResult: arbitraryValidationResult(),
    evidenceHash: fc.option(arbitraryEvidenceHash()),
    validatedAt: arbitraryPastDate(),
    createdAt: arbitraryPastDate()
  })

// Generate an organization ID
export const arbitraryOrganizationId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `org-${s}`)

// Generate a team ID
export const arbitraryTeamId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `team-${s}`)

// Generate a user ID
export const arbitraryUserId = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 10, maxLength: 64 }).map(s => `user-${s}`)

// Generate a contract address (Contract IDs are 56 chars starting with C on Stellar)
export const arbitraryContractAddress = (): fc.Arbitrary<string> =>
  fc.string({ minLength: 54, maxLength: 54 }).map(s => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    let result = 'C'
    for (let i = 0; i < 54; i++) {
      const idx = Math.abs((s.charCodeAt(i % s.length) + i * 17) % chars.length)
      result += chars[idx]
    }
    return result
  })

// Generate a valid Horizon URL
export const arbitraryHorizonUrl = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant('https://horizon.stellar.org'),
    fc.constant('https://horizon-testnet.stellar.org'),
    fc.constant('https://horizon-futurenet.stellar.org'),
    fc.string({ minLength: 20, maxLength: 100 }).map(s => `https://${s.split('').map(c => 'abcdefghijklmnopqrstuvwxyz.'[Math.abs(c.charCodeAt(0)) % 28]).join('')}`)
  )

// Generate a milestone status
export const arbitraryMilestoneStatus = (): fc.Arbitrary<'pending' | 'in_progress' | 'completed' | 'failed'> =>
  fc.constantFrom('pending', 'in_progress', 'completed', 'failed')

// Generate a unique vault ID (for testing uniqueness constraints)
export const arbitraryUniqueVaultId = (): fc.Arbitrary<string> =>
  fc.uniqueArray(arbitraryVaultId(), { minLength: 1, maxLength: 10 }).map(arr => arr[0])

// Generate multiple events as a sequence
export const arbitraryEventSequence = (minEvents: number = 2, maxEvents: number = 10): fc.Arbitrary<ParsedEvent[]> =>
  fc.array(arbitraryParsedEvent(), { minLength: minEvents, maxLength: maxEvents })

// Generate events for a specific vault (all related events)
export const arbitraryVaultEventSequence = (): fc.Arbitrary<{
  created: ParsedEvent
  milestones: ParsedEvent[]
  completed: ParsedEvent
}> =>
  fc.record({
    created: arbitraryVaultCreatedEvent(),
    milestones: fc.array(arbitraryMilestoneCreatedEvent(), { minLength: 1, maxLength: 5 }),
    completed: arbitraryVaultCompletedEvent()
  })

// Generate edge case: empty strings, extreme values
export const arbitraryEdgeCaseAmount = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant('0.0000000'),
    fc.constant('0.0000001'),
    fc.constant('999999.9999999'),
    fc.constant('1000000.0000000'),
    arbitraryAmount()
  )

// Generate edge case: very long strings
export const arbitraryEdgeCaseString = (): fc.Arbitrary<string> =>
  fc.oneof(
    fc.constant(''),
    fc.string({ minLength: 1000, maxLength: 2000 }),
    fc.string({ minLength: 1, maxLength: 255 })
  )

// Filtered arbitrary: valid Stellar address without special chars in payload
export const arbitrarySafeStellarAddress = (): fc.Arbitrary<string> =>
  arbitraryStellarAddress().map(addr => addr.replace(/[^A-Z0-9]/g, '').slice(0, 56))

// Generate a vault with invalid state transitions for negative testing
export const arbitraryInvalidStatusTransition = (): fc.Arbitrary<{
  fromStatus: 'active' | 'completed' | 'failed' | 'cancelled'
  toStatus: 'active' | 'completed' | 'failed' | 'cancelled'
  isValid: boolean
}> =>
  fc.record({
    fromStatus: arbitraryVaultStatus(),
    toStatus: arbitraryVaultStatus(),
    isValid: fc.boolean()
  }).map(record => {
    const invalidTransitions = [
      { from: 'completed', to: 'active' },
      { from: 'failed', to: 'active' },
      { from: 'cancelled', to: 'active' },
      { from: 'completed', to: 'failed' },
      { from: 'failed', to: 'completed' }
    ]
    const isInvalid = invalidTransitions.some(t => t.from === record.fromStatus && t.to === record.toStatus)
    return { ...record, isValid: !isInvalid }
  })
