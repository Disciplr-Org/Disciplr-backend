// Type definitions for Horizon Listener → Database Sync feature

// Event Types
export type EventType =
  | 'vault_created'
  | 'vault_completed'
  | 'vault_failed'
  | 'vault_cancelled'
  | 'milestone_created'
  | 'milestone_created'
  | 'milestone_validated'

export interface HorizonOperation {
  id: string
  transaction_hash: string
  type: string
  created_at: string
  [key: string]: any
}

export interface HorizonTransaction {
  id: string
  hash: string
  ledger: number
  created_at: string
  [key: string]: any
}

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

// Configuration Interfaces
export interface HorizonListenerConfig {
  horizonUrl: string
  contractAddresses: string[]
  startLedger?: number
  retryMaxAttempts: number
  retryBackoffMs: number
  shutdownTimeoutMs: number
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
