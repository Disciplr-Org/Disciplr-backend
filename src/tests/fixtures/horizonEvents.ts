import { ParsedEvent, HorizonOperation, HorizonTransaction } from '../../types/horizonSync.js'

/**
 * Mocked Horizon event fixtures for testing
 */

export const mockHorizonOperation = (overrides?: Partial<HorizonOperation>): HorizonOperation => ({
  id: 'op-123',
  transaction_hash: 'tx-tx-123',
  type: 'invoke_host_function',
  created_at: new Date().toISOString(),
  ...overrides,
})

export const mockHorizonTransaction = (overrides?: Partial<HorizonTransaction>): HorizonTransaction => ({
  id: 'tx-tx-123',
  hash: 'tx-tx-123',
  ledger: 100,
  created_at: new Date().toISOString(),
  ...overrides,
})

export const mockVaultCreatedEvent = (overrides?: Partial<ParsedEvent>): ParsedEvent => ({
  eventId: 'tx1:0',
  transactionHash: 'tx1',
  eventIndex: 0,
  ledgerNumber: 100,
  eventType: 'vault_created',
  payload: {
    vaultId: 'vault-1',
    creator: 'G...',
    amount: '1000',
    status: 'active'
  },
  ...overrides,
})

export const mockVaultCompletedEvent = (overrides?: Partial<ParsedEvent>): ParsedEvent => ({
  eventId: 'tx2:0',
  transactionHash: 'tx2',
  eventIndex: 0,
  ledgerNumber: 101,
  eventType: 'vault_completed',
  payload: {
    vaultId: 'vault-1',
    status: 'completed'
  },
  ...overrides,
})

export const mockMilestoneValidatedEvent = (overrides?: Partial<ParsedEvent>): ParsedEvent => ({
  eventId: 'tx3:0',
  transactionHash: 'tx3',
  eventIndex: 0,
  ledgerNumber: 102,
  eventType: 'milestone_validated',
  payload: {
    validationId: 'val-1',
    milestoneId: 'ms-1',
    validatorAddress: 'G...',
    validationResult: 'approved',
    evidenceHash: 'hash-1',
    validatedAt: new Date()
  },
  ...overrides,
})

export const createMockVaultCreatedEvent = (vaultId: string, creator: string) => 
  mockVaultCreatedEvent({ payload: { vaultId, creator, amount: '1000', status: 'active' } })

export const allMockEvents: ParsedEvent[] = [
  mockVaultCreatedEvent(),
  mockVaultCompletedEvent(),
  mockMilestoneValidatedEvent()
]
