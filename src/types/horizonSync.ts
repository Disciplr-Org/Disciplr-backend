// Type definitions for Horizon Listener → Database Sync feature

// Event Types
export type EventType =
  | 'vault_created'
  | 'vault_completed'
  | 'vault_failed'
  | 'vault_cancelled'
  | 'milestone_created'
  | 'milestone_validated'
  | 'settlement_summary'

// Parsed Event Interface
export interface ParsedEvent {
  eventId: string
  transactionHash: string
  eventIndex: number
  ledgerNumber: number
  eventType: EventType
  payload: VaultEventPayload | MilestoneEventPayload | ValidationEventPayload
}

// Event Payload Interfaces
export interface VaultEventPayload {
  vaultId: string
  creator?: string
  amount?: string
  startTimestamp?: Date
  endTimestamp?: Date
  successDestination?: string
  failureDestination?: string
  status?: 'active' | 'completed' | 'failed' | 'cancelled'
}

export interface MilestoneEventPayload {
  milestoneId: string
  vaultId: string
  title: string
  description: string
  targetAmount: string
  deadline: Date
}

export interface ValidationEventPayload {
  validationId: string
  milestoneId: string
  validatorAddress: string
  validationResult: 'approved' | 'rejected' | 'pending_review'
  evidenceHash: string
  validatedAt: Date
}

/** Emitted by `claim` and `slash_on_miss` in the accountability_vault contract. */
export interface SettlementSummaryEventPayload {
  releasedAmount: string
  slashedAmount: string
  verifiedCount: number
  finalStatus: 'completed' | 'slashed'
}

// Database Entity Interfaces
export interface Milestone {
  id: string
  vaultId: string
  title: string
  description: string | null
  targetAmount: string
  currentAmount: string
  deadline: Date
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  createdAt: Date
  updatedAt: Date
}

export interface Validation {
  id: string
  milestoneId: string
  validatorAddress: string
  validationResult: 'approved' | 'rejected' | 'pending_review'
  evidenceHash: string | null
  validatedAt: Date
  createdAt: Date
}

export interface ProcessedEvent {
  eventId: string
  transactionHash: string
  eventIndex: number
  ledgerNumber: number
  processedAt: Date
  createdAt: Date
}

export interface FailedEvent {
  id: number
  eventId: string
  eventPayload: ParsedEvent
  errorMessage: string
  retryCount: number
  failedAt: Date
  createdAt: Date
}

export interface ListenerState {
  id: number
  serviceName: string
  lastProcessedLedger: number
  lastProcessedAt: Date
  createdAt: Date
  updatedAt: Date
}

/** Per-contract checkpoint stored in horizon_checkpoints. */
export interface HorizonCheckpoint {
  id: number
  contractAddress: string
  lastLedger: number
  lastPagingToken: string | null
  updatedAt: Date
  createdAt: Date
}

// Configuration Interfaces
export interface HorizonListenerConfig {
  horizonUrl: string
  contractAddresses: string[]
  startLedger?: number
  retryMaxAttempts: number
  retryBackoffMs: number
  shutdownTimeoutMs: number
  lagThreshold: number
}

export interface ProcessorConfig {
  maxRetries: number
  retryBackoffMs: number
}

export interface RetryConfig {
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  backoffMultiplier: number
}
