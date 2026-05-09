import { ParsedEvent } from '../../types/horizonSync.js'
import { HorizonEvent } from '../../services/eventParser.js'

/**
 * Mocked Horizon event fixtures for testing
 * These fixtures represent parsed events with valid XDR-encoded payloads
 */

// Mock Vault Created Event
export const mockVaultCreatedEvent: ParsedEvent = {
  eventId: 'abc123def456:0',
  transactionHash: 'abc123def456',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-test-001',
    creator: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: '1000.0000000',
    startTimestamp: new Date('2024-01-01T00:00:00Z'),
    endTimestamp: new Date('2024-12-31T23:59:59Z'),
    successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'active'
  }
}

// Mock Vault Completed Event
export const mockVaultCompletedEvent: ParsedEvent = {
  eventId: 'abc123def456:1',
  transactionHash: 'abc123def456',
  eventIndex: 1,
  ledgerNumber: 12346,
  eventType: 'vault_completed',
  payload: {
    vaultId: 'vault-test-001',
    status: 'completed'
  }
}

// Mock Vault Failed Event
export const mockVaultFailedEvent: ParsedEvent = {
  eventId: 'abc123def456:2',
  transactionHash: 'abc123def456',
  eventIndex: 2,
  ledgerNumber: 12347,
  eventType: 'vault_failed',
  payload: {
    vaultId: 'vault-test-002',
    status: 'failed'
  }
}

// Mock Vault Cancelled Event
export const mockVaultCancelledEvent: ParsedEvent = {
  eventId: 'abc123def456:3',
  transactionHash: 'abc123def456',
  eventIndex: 3,
  ledgerNumber: 12348,
  eventType: 'vault_cancelled',
  payload: {
    vaultId: 'vault-test-003',
    status: 'cancelled'
  }
}

// Mock Milestone Created Event
export const mockMilestoneCreatedEvent: ParsedEvent = {
  eventId: 'def789ghi012:0',
  transactionHash: 'def789ghi012',
  eventIndex: 0,
  ledgerNumber: 12349,
  eventType: 'milestone_created',
  payload: {
    milestoneId: 'milestone-test-001',
    vaultId: 'vault-test-001',
    title: 'First Milestone',
    description: 'Complete the first task',
    targetAmount: '500.0000000',
    deadline: new Date('2024-06-30T23:59:59Z')
  }
}

// Mock Milestone Validated Event
export const mockMilestoneValidatedEvent: ParsedEvent = {
  eventId: 'ghi345jkl678:0',
  transactionHash: 'ghi345jkl678',
  eventIndex: 0,
  ledgerNumber: 12350,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'validation-test-001',
    milestoneId: 'milestone-test-001',
    validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    validationResult: 'approved',
    evidenceHash: 'hash-abc123def456',
    validatedAt: new Date('2024-03-15T10:30:00Z')
  }
}

// Mock Milestone Validated Event - Rejected
export const mockMilestoneRejectedEvent: ParsedEvent = {
  eventId: 'jkl901mno234:0',
  transactionHash: 'jkl901mno234',
  eventIndex: 0,
  ledgerNumber: 12351,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'validation-test-002',
    milestoneId: 'milestone-test-002',
    validatorAddress: 'GVALIDATOR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    validationResult: 'rejected',
    evidenceHash: 'hash-def789ghi012',
    validatedAt: new Date('2024-03-16T14:45:00Z')
  }
}

// Mock Milestone Validated Event - Pending Review
export const mockMilestonePendingReviewEvent: ParsedEvent = {
  eventId: 'mno567pqr890:0',
  transactionHash: 'mno567pqr890',
  eventIndex: 0,
  ledgerNumber: 12352,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'validation-test-003',
    milestoneId: 'milestone-test-003',
    validatorAddress: 'GVALIDATOR3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    validationResult: 'pending_review',
    evidenceHash: 'hash-ghi345jkl678',
    validatedAt: new Date('2024-03-17T09:15:00Z')
  }
}

// Collection of all mock events for easy iteration in tests
export const allMockEvents: ParsedEvent[] = [
  mockVaultCreatedEvent,
  mockVaultCompletedEvent,
  mockVaultFailedEvent,
  mockVaultCancelledEvent,
  mockMilestoneCreatedEvent,
  mockMilestoneValidatedEvent,
  mockMilestoneRejectedEvent,
  mockMilestonePendingReviewEvent
]

export function encodeMockHorizonPayload(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

export function createRawHorizonEvent(
  eventType: ParsedEvent['eventType'],
  payload: Record<string, unknown>,
  overrides: Partial<HorizonEvent> = {}
): HorizonEvent {
  const txHash = overrides.txHash ?? 'abc123def456'
  const eventIndex = overrides.id
    ? Number.parseInt(overrides.id.split('-').pop() ?? '0', 10) || 0
    : 0

  return {
    type: 'contract',
    ledger: overrides.ledger ?? 12345,
    ledgerClosedAt: overrides.ledgerClosedAt ?? '2024-01-15T10:30:00Z',
    contractId: overrides.contractId ?? 'CDISCIPLR123',
    id: overrides.id ?? `${txHash}-${eventIndex}`,
    pagingToken: overrides.pagingToken ?? `${txHash}-${eventIndex}`,
    topic: overrides.topic ?? [eventType],
    value: overrides.value ?? {
      xdr: encodeMockHorizonPayload(payload)
    },
    inSuccessfulContractCall: overrides.inSuccessfulContractCall ?? true,
    txHash
  }
}

// Helper function to create a custom vault created event
export function createMockVaultCreatedEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    ...mockVaultCreatedEvent,
    ...overrides,
    payload: {
      ...mockVaultCreatedEvent.payload,
      ...(overrides.payload || {})
    }
  }
}

// Helper function to create a custom milestone created event
export function createMockMilestoneCreatedEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    ...mockMilestoneCreatedEvent,
    ...overrides,
    payload: {
      ...mockMilestoneCreatedEvent.payload,
      ...(overrides.payload || {})
    }
  }
}

// Helper function to create a custom validation event
export function createMockValidationEvent(overrides: Partial<ParsedEvent> = {}): ParsedEvent {
  return {
    ...mockMilestoneValidatedEvent,
    ...overrides,
    payload: {
      ...mockMilestoneValidatedEvent.payload,
      ...(overrides.payload || {})
    }
  }
}

// Edge case fixtures for testing

// Vault created event with minimum valid values
export const mockVaultCreatedMinValues: ParsedEvent = {
  eventId: 'min123:0',
  transactionHash: 'min123',
  eventIndex: 0,
  ledgerNumber: 1,
  eventType: 'vault_created',
  payload: {
    vaultId: 'v',
    creator: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    amount: '0.0000001',
    startTimestamp: new Date('2024-01-01T00:00:00Z'),
    endTimestamp: new Date('2024-01-01T00:00:01Z'),
    successDestination: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    failureDestination: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    status: 'active'
  }
}

// Vault created event with maximum valid values
export const mockVaultCreatedMaxValues: ParsedEvent = {
  eventId: 'max456:0',
  transactionHash: 'max456',
  eventIndex: 0,
  ledgerNumber: 999999999,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-' + 'x'.repeat(100),
    creator: 'GZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    amount: '999999999.9999999',
    startTimestamp: new Date('2020-01-01T00:00:00Z'),
    endTimestamp: new Date('2030-12-31T23:59:59Z'),
    successDestination: 'GYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYY',
    failureDestination: 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'active'
  }
}

// Milestone created event with edge case values
export const mockMilestoneCreatedEdgeCases: ParsedEvent = {
  eventId: 'edge789:0',
  transactionHash: 'edge789',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'milestone_created',
  payload: {
    milestoneId: 'milestone-' + 'a'.repeat(255),
    vaultId: 'vault-edge',
    title: 't'.repeat(255),
    description: 'd'.repeat(1000),
    targetAmount: '0.0000001',
    deadline: new Date('2030-12-31T23:59:59Z')
  }
}

// Validation event with special characters in evidence hash
export const mockValidationSpecialChars: ParsedEvent = {
  eventId: 'spec012:0',
  transactionHash: 'spec012',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'validation-special-chars-123',
    milestoneId: 'milestone-special',
    validatorAddress: 'GSPECIALXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    validationResult: 'pending_review',
    evidenceHash: 'hash_with_underscores_and-hyphens123',
    validatedAt: new Date('2024-06-15T10:30:00Z')
  }
}

// Invalid fixtures for negative testing

// Vault created with invalid Stellar address
export const mockVaultCreatedInvalidAddress: ParsedEvent = {
  eventId: 'inv001:0',
  transactionHash: 'inv001',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-invalid',
    creator: 'INVALID_ADDRESS_FORMAT',
    amount: '1000.0000000',
    startTimestamp: new Date('2024-01-01T00:00:00Z'),
    endTimestamp: new Date('2024-12-31T00:00:00Z'),
    successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'active'
  }
}

// Vault created with invalid amount
export const mockVaultCreatedInvalidAmount: ParsedEvent = {
  eventId: 'inv002:0',
  transactionHash: 'inv002',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-invalid-amount',
    creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: 'invalid_amount',
    startTimestamp: new Date('2024-01-01T00:00:00Z'),
    endTimestamp: new Date('2024-12-31T00:00:00Z'),
    successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'active'
  }
}

// Milestone created with past deadline
export const mockMilestoneCreatedPastDeadline: ParsedEvent = {
  eventId: 'inv003:0',
  transactionHash: 'inv003',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'milestone_created',
  payload: {
    milestoneId: 'milestone-past',
    vaultId: 'vault-past',
    title: 'Past Milestone',
    description: 'This should be rejected',
    targetAmount: '500.0000000',
    deadline: new Date('2020-01-01T00:00:00Z') // Past date
  }
}

// Validation event with invalid evidence hash
export const mockValidationInvalidEvidenceHash: ParsedEvent = {
  eventId: 'inv004:0',
  transactionHash: 'inv004',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'validation-invalid-hash',
    milestoneId: 'milestone-invalid',
    validatorAddress: 'GVALIDATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    validationResult: 'approved',
    evidenceHash: 'hash@with$special#chars!',
    validatedAt: new Date('2024-03-15T10:30:00Z')
  }
}

// Event with unknown fields (should be rejected by strict validation)
export const mockVaultCreatedWithUnknownFields: ParsedEvent = {
  eventId: 'inv005:0',
  transactionHash: 'inv005',
  eventIndex: 0,
  ledgerNumber: 12345,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-unknown',
    creator: 'GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    amount: '1000.0000000',
    startTimestamp: new Date('2024-01-01T00:00:00Z'),
    endTimestamp: new Date('2024-12-31T00:00:00Z'),
    successDestination: 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    failureDestination: 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    status: 'active',
    unknownField: 'this should cause rejection',
    anotherUnknownField: 123
  } as any
}

// Collection of all edge case events
export const allEdgeCaseEvents: ParsedEvent[] = [
  mockVaultCreatedMinValues,
  mockVaultCreatedMaxValues,
  mockMilestoneCreatedEdgeCases,
  mockValidationSpecialChars
]

// Collection of all invalid events
export const allInvalidEvents: ParsedEvent[] = [
  mockVaultCreatedInvalidAddress,
  mockVaultCreatedInvalidAmount,
  mockMilestoneCreatedPastDeadline,
  mockValidationInvalidEvidenceHash,
  mockVaultCreatedWithUnknownFields
]

// Helper function to create events with prototype pollution attempts
export function createPrototypePollutionEvent(): ParsedEvent {
  const pollutedEvent = { ...mockVaultCreatedEvent }
  
  // Add prototype pollution properties
  Object.defineProperty(pollutedEvent.payload, '__proto__', {
    value: { polluted: true },
    enumerable: true,
    writable: true,
    configurable: true
  })
  
  Object.defineProperty(pollutedEvent.payload, 'constructor', {
    value: { prototype: { hacked: true } },
    enumerable: true,
    writable: true,
    configurable: true
  })
  
  return pollutedEvent
}

// Helper function to create events with null/undefined values
export function createNullUndefinedEvent(): ParsedEvent {
  return {
    eventId: 'nullundef:0',
    transactionHash: 'nullundef',
    eventIndex: 0,
    ledgerNumber: 12345,
    eventType: 'vault_created',
    payload: {
      vaultId: null as any,
      creator: undefined as any,
      amount: null as any,
      startTimestamp: undefined as any,
      endTimestamp: null as any,
      successDestination: undefined as any,
      failureDestination: null as any,
      status: 'active'
    }
  }
}
