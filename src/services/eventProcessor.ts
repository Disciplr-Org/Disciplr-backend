import { Knex } from 'knex'
import { ParsedEvent, ProcessorConfig, VaultEventPayload, MilestoneEventPayload, ValidationEventPayload } from '../types/horizonSync.js'
import { retryWithBackoff, isRetryable } from '../utils/retry.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { IdempotencyService } from './idempotency.js'
import { dispatchWebhookEvent, VAULT_LIFECYCLE_EVENTS } from './webhooks.js'

/**
 * Error thrown when a dependency (e.g., a vault for a milestone) is not yet in the DB.
 * This should be treated as retryable for out-of-order event handling.
 */
export class DependencyNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DependencyNotFoundError'
  }
}

/**
 * Result of processing an event
 */
export interface ProcessingResult {
  success: boolean
  eventId: string
  error?: string
  retryCount?: number
}

/**
 * Event Processor Service
 * Handles idempotent processing of blockchain events into database operations
 */
export class EventProcessor {
  private db: Knex
  private config: ProcessorConfig
  private idempotency: IdempotencyService

  constructor(db: Knex, config: ProcessorConfig) {
    this.db = db
    this.config = config
    this.idempotency = new IdempotencyService(db)
  }

  /**
   * Custom retryable check that includes DependencyNotFoundError
   */
  private isRetryableEventError(error: Error): boolean {
    if (error instanceof DependencyNotFoundError) {
      return true
    }
    return isRetryable(error)
  }

  /**
   * Process an event with idempotency checking, retry logic, and audit logging
   */
  async processEvent(event: ParsedEvent): Promise<ProcessingResult> {
    const startTime = Date.now()

    try {
      await retryWithBackoff(
        async () => {
          await this.processEventWithTransaction(event)
        },
        {
          maxAttempts: this.config.maxRetries,
          initialBackoffMs: this.config.retryBackoffMs,
          maxBackoffMs: 60000,
          backoffMultiplier: 2,
          jitterFactor: 0.5
        },
        this.isRetryableEventError.bind(this)
      )

      const processingDurationMs = Date.now() - startTime
      createAuditLog({
        actor_user_id: 'system',
        action: 'event_processed',
        target_type: event.eventType,
        target_id: event.eventId,
        metadata: {
          event_type: event.eventType,
          transaction_hash: event.transactionHash,
          ledger_number: event.ledgerNumber,
          processing_duration_ms: processingDurationMs
        }
      })

      // Fire-and-forget webhook dispatch for vault lifecycle events
      if (VAULT_LIFECYCLE_EVENTS.has(event.eventType)) {
        dispatchWebhookEvent({
          eventId: event.eventId,
          eventType: event.eventType,
          timestamp: new Date().toISOString(),
          data: event.payload as unknown as Record<string, unknown>,
        }).catch((err) => {
          console.error('[EventProcessor] webhook dispatch error:', err?.message)
        })
      }

      return { success: true, eventId: event.eventId }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const retryable = error instanceof Error ? this.isRetryableEventError(error) : false
      const processingDurationMs = Date.now() - startTime

      createAuditLog({
        actor_user_id: 'system',
        action: 'event_processing_failed',
        target_type: event.eventType,
        target_id: event.eventId,
        metadata: {
          event_type: event.eventType,
          transaction_hash: event.transactionHash,
          ledger_number: event.ledgerNumber,
          processing_duration_ms: processingDurationMs,
          error_message: errorMessage,
          retryable
        }
      })

      if (retryable) {
        // Move to dead letter queue only if we've exhausted retries or if it's a persistent transient error
        await this.moveToDeadLetterQueue(event, errorMessage, this.config.maxRetries)
      }

      return {
        success: false,
        eventId: event.eventId,
        error: errorMessage,
        retryCount: retryable ? this.config.maxRetries : 0
      }
    }
  }

  private async processEventWithTransaction(event: ParsedEvent): Promise<void> {
    const trx = await this.db.transaction()

    try {
      const alreadyProcessed = await this.idempotency.isEventProcessed(event.eventId, trx)
      if (alreadyProcessed) {
        await trx.commit()
        return
      }

      await this.routeEvent(event, trx)
      await this.idempotency.markEventProcessed(event, trx)
      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }

  private async routeEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    switch (event.eventType) {
      case 'vault_created':
      case 'vault_completed':
      case 'vault_failed':
      case 'vault_cancelled':
        await this.handleVaultEvent(event, trx)
        break
      case 'milestone_created':
        await this.handleMilestoneEvent(event, trx)
        break
      case 'milestone_validated':
        await this.handleValidationEvent(event, trx)
        break
      default:
        throw new Error(`Unknown event type: ${event.eventType}`)
    }
  }

  private async handleVaultEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as VaultEventPayload

    if (event.eventType === 'vault_created') {
      await trx('vaults')
        .insert({
          id: payload.vaultId,
          creator: payload.creator,
          amount: payload.amount,
          start_timestamp: payload.startTimestamp,
          end_timestamp: payload.endTimestamp,
          success_destination: payload.successDestination,
          failure_destination: payload.failureDestination,
          status: 'active',
          created_at: new Date()
        })
        .onConflict('id')
        .ignore() // Use ignore instead of merge to prevent overwriting if vault_created arrives late
    } else {
      const status = event.eventType.replace('vault_', '') as 'completed' | 'failed' | 'cancelled'
      const updated = await trx('vaults')
        .where({ id: payload.vaultId })
        .update({
          status,
          updated_at: new Date()
        })

      if (updated === 0) {
        throw new DependencyNotFoundError(`Vault not found for update: ${payload.vaultId}`)
      }
    }
  }

  private async handleMilestoneEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as MilestoneEventPayload

    const vault = await trx('vaults').where({ id: payload.vaultId }).first()
    if (!vault) {
      throw new DependencyNotFoundError(`Vault not found for milestone: ${payload.vaultId}`)
    }

    await trx('milestones')
      .insert({
        id: payload.milestoneId,
        vault_id: payload.vaultId,
        title: payload.title,
        description: payload.description,
        target_amount: payload.targetAmount,
        current_amount: '0',
        deadline: payload.deadline,
        status: 'pending',
        created_at: new Date(),
        updated_at: new Date()
      })
      .onConflict('id')
      .ignore()
  }

  private async handleValidationEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as ValidationEventPayload

    const milestone = await trx('milestones').where({ id: payload.milestoneId }).first()
    if (!milestone) {
      throw new DependencyNotFoundError(`Milestone not found for validation: ${payload.milestoneId}`)
    }

    await trx('validations')
      .insert({
        id: payload.validationId,
        milestone_id: payload.milestoneId,
        validator_address: payload.validatorAddress,
        validation_result: payload.validationResult,
        evidence_hash: payload.evidenceHash,
        validated_at: payload.validatedAt,
        created_at: new Date()
      })
      .onConflict('id')
      .ignore()

    const updateFields: Record<string, unknown> = { updated_at: new Date() }
    if (payload.validationResult === 'approved') {
      updateFields.status = 'completed'
      updateFields.current_amount = milestone.target_amount
    } else if (payload.validationResult === 'rejected') {
      updateFields.status = 'failed'
    }

    if (Object.keys(updateFields).length > 1) {
      await trx('milestones')
        .where({ id: payload.milestoneId })
        .update(updateFields)
    }
  }

  private async moveToDeadLetterQueue(
    event: ParsedEvent,
    errorMessage: string,
    retryCount: number
  ): Promise<void> {
    try {
      const failedEvent = {
        event_id: event.eventId,
        event_payload: event,
        error_message: errorMessage,
        retry_count: retryCount,
        failed_at: new Date(),
        created_at: new Date()
      }
      const existing = await this.db('failed_events').where({ event_id: event.eventId }).first()

      if (existing) {
        await this.db('failed_events')
          .where({ event_id: event.eventId })
          .update({
            event_payload: failedEvent.event_payload,
            error_message: failedEvent.error_message,
            retry_count: failedEvent.retry_count,
            failed_at: failedEvent.failed_at
          })
      } else {
        await this.db('failed_events').insert(failedEvent)
      }
    } catch (error) {
      console.error('Failed to insert into dead letter queue:', error)
    }
  }

  async reprocessFailedEvent(failedEventId: string): Promise<ProcessingResult> {
    const failedEvent = await this.db('failed_events').where({ event_id: failedEventId }).first()
    if (!failedEvent) {
      return { success: false, eventId: failedEventId, error: 'Failed event not found' }
    }

    const event: ParsedEvent = typeof failedEvent.event_payload === 'string'
      ? JSON.parse(failedEvent.event_payload)
      : failedEvent.event_payload
    const result = await this.processEvent(event)

    if (result.success) {
      await this.db('failed_events').where({ event_id: failedEventId }).delete()
    }

    return result
  }
}
