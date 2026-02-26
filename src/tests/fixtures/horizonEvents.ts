import { ParsedEvent } from '../../types/horizonSync.js'

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
