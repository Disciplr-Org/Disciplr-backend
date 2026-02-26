import fc from 'fast-check'
import {
  ParsedEvent,
  VaultEventPayload,
  MilestoneEventPayload,
  ValidationEventPayload,
  HorizonOperation,
  HorizonTransaction
} from '../../types/horizonSync.js'

/**
 * Fast-check arbitraries for property-based testing
 */

export const operationArbitrary = fc.record({
  id: fc.string(),
  transaction_hash: fc.string(),
  type: fc.constant('invoke_host_function'),
  created_at: fc.date().map(d => d.toISOString()),
})

export const transactionArbitrary = fc.record({
  id: fc.string(),
  hash: fc.string(),
  ledger: fc.integer({ min: 1 }),
  created_at: fc.date().map(d => d.toISOString()),
})

export const arbitraryVaultCreatedEvent = fc.record({
  vaultId: fc.string(),
  creator: fc.string(),
  amount: fc.string(),
  status: fc.constant('active' as const)
})

export const arbitraryMilestoneCreatedEvent = fc.record({
  milestoneId: fc.string(),
  vaultId: fc.string(),
  title: fc.string(),
  targetAmount: fc.string(),
  deadline: fc.date()
})

export const arbitraryParsedEvent = fc.record({
  eventId: fc.string(),
  transactionHash: fc.string(),
  eventIndex: fc.integer(),
  ledgerNumber: fc.integer(),
  eventType: fc.constantFrom('vault_created' as const, 'vault_completed' as const, 'milestone_validated' as const),
  payload: fc.oneof(arbitraryVaultCreatedEvent, arbitraryMilestoneCreatedEvent) as any
})
