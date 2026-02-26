import { Knex } from 'knex'
import { ParsedEvent, ProcessorConfig, VaultEventPayload, MilestoneEventPayload, ValidationEventPayload } from '../types/horizonSync.js'
import { retryWithBackoff, DEFAULT_RETRY_CONFIG } from '../utils/retry.js'
import { createAuditLog } from '../lib/audit-logs.js'

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

  constructor(db: Knex, config: ProcessorConfig) {
    this.db = db
    this.config = config
  }

  /**
   * Process an event with idempotency checking, retry logic, and audit logging
   * 
   * @param event - Parsed event to process
   * @returns ProcessingResult indicating success or failure
   */
  async processEvent(event: ParsedEvent): Promise<ProcessingResult> {
    const startTime = Date.now()
    let retryCount = 0

    try {
      // Attempt processing with retry logic
      await retryWithBackoff(
        async () => {
          await this.processEventWithTransaction(event)
        },
        {
          maxAttempts: this.config.maxRetries,
          initialBackoffMs: this.config.retryBackoffMs,
          maxBackoffMs: 60000,
          backoffMultiplier: 2
        }
      )

      // Create audit log for successful processing
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

      return {
        success: true,
        eventId: event.eventId
      }
    } catch (error) {
      retryCount = this.config.maxRetries
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      const processingDurationMs = Date.now() - startTime

      // Create audit log for failed processing
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
          retry_count: retryCount
        }
      })

      // Move to dead letter queue if retries exhausted
      await this.moveToDeadLetterQueue(event, errorMessage, retryCount)

      return {
        success: false,
        eventId: event.eventId,
        error: errorMessage,
        retryCount
      }
    }
  }

  /**
   * Process event within a database transaction with idempotency checking
   * 
   * @param event - Parsed event to process
   */
  private async processEventWithTransaction(event: ParsedEvent): Promise<void> {
    const trx = await this.db.transaction()

    try {
      // Check idempotency - if event already processed, return success
      const existing = await trx('processed_events')
        .where({ event_id: event.eventId })
        .first()

      if (existing) {
        await trx.commit()
        return // Already processed
      }

      // Route to appropriate handler based on event type
      await this.routeEvent(event, trx)

      // Store event_id in processed_events table
      await trx('processed_events').insert({
        event_id: event.eventId,
        transaction_hash: event.transactionHash,
        event_index: event.eventIndex,
        ledger_number: event.ledgerNumber,
        processed_at: new Date(),
        created_at: new Date()
      })

      // Commit transaction
      await trx.commit()
    } catch (error) {
      // Rollback transaction on any error
      await trx.rollback()
      throw error
    }
  }

  /**
   * Route event to appropriate handler based on event type
   * 
   * @param event - Parsed event to route
   * @param trx - Database transaction
   */
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

  /**
   * Handle vault events (created, completed, failed, cancelled)
   * 
   * @param event - Parsed vault event
   * @param trx - Database transaction
   */
  private async handleVaultEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as VaultEventPayload

    if (event.eventType === 'vault_created') {
      // Insert or update vault record with all required fields
      await trx('vaults')
        .insert({
          id: payload.vaultId,
          creator: payload.creator!,
          amount: payload.amount!,
          start_timestamp: payload.startTimestamp!,
          end_timestamp: payload.endTimestamp!,
          success_destination: payload.successDestination!,
          failure_destination: payload.failureDestination!,
          status: payload.status || 'active',
          created_at: new Date()
        })
        .onConflict('id')
        .merge()
    } else {
      // Update vault status for completed, failed, or cancelled events
      const status = event.eventType.replace('vault_', '') as 'completed' | 'failed' | 'cancelled'
      
      await trx('vaults')
        .where({ id: payload.vaultId })
        .update({ status })
    }
  }

  /**
   * Handle milestone_created events
   * 
   * @param event - Parsed milestone event
   * @param trx - Database transaction
   */
  private async handleMilestoneEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as MilestoneEventPayload

    // Validate that referenced vault exists
    const vault = await trx('vaults')
      .where({ id: payload.vaultId })
      .first()

    if (!vault) {
      throw new Error(`Vault not found: ${payload.vaultId}`)
    }

    // Insert milestone record
    await trx('milestones').insert({
      id: payload.milestoneId,
      vault_id: payload.vaultId,
      title: payload.title,
      description: payload.description || null,
      target_amount: payload.targetAmount,
      current_amount: '0',
      deadline: payload.deadline,
      status: 'pending',
      created_at: new Date(),
      updated_at: new Date()
    })
  }

  /**
   * Handle milestone_validated events
   * 
   * @param event - Parsed validation event
   * @param trx - Database transaction
   */
  private async handleValidationEvent(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    const payload = event.payload as ValidationEventPayload

    // Validate that referenced milestone exists
    const milestone = await trx('milestones')
      .where({ id: payload.milestoneId })
      .first()

    if (!milestone) {
      throw new Error(`Milestone not found: ${payload.milestoneId}`)
    }

    // Insert validation record
    await trx('validations').insert({
      id: payload.validationId,
      milestone_id: payload.milestoneId,
      validator_address: payload.validatorAddress,
      validation_result: payload.validationResult,
      evidence_hash: payload.evidenceHash || null,
      validated_at: payload.validatedAt,
      created_at: new Date()
    })
  }

  /**
   * Move failed event to dead letter queue after exhausting retries
   * 
   * @param event - Failed event
   * @param errorMessage - Error message
   * @param retryCount - Number of retry attempts
   */
  private async moveToDeadLetterQueue(
    event: ParsedEvent,
    errorMessage: string,
    retryCount: number
  ): Promise<void> {
    try {
      await this.db('failed_events').insert({
        event_id: event.eventId,
        event_payload: JSON.stringify(event),
        error_message: errorMessage,
        retry_count: retryCount,
        failed_at: new Date(),
        created_at: new Date()
      })
    } catch (error) {
      // Log error but don't throw - we don't want to fail the original operation
      console.error('Failed to insert into dead letter queue:', error)
    }
  }

  /**
   * Reprocess a failed event from the dead letter queue
   * 
   * @param failedEventId - ID of the failed event to reprocess
   * @returns ProcessingResult indicating success or failure
   */
  async reprocessFailedEvent(failedEventId: string): Promise<ProcessingResult> {
    // Query failed_events table
    const failedEvent = await this.db('failed_events')
      .where({ event_id: failedEventId })
      .first()

    if (!failedEvent) {
      return {
        success: false,
        eventId: failedEventId,
        error: 'Failed event not found'
      }
    }

    // Parse event_payload JSON back to ParsedEvent
    const event: ParsedEvent = JSON.parse(failedEvent.event_payload)

    // Process the event
    const result = await this.processEvent(event)

    // If successful, delete from failed_events
    if (result.success) {
      await this.db('failed_events')
        .where({ event_id: failedEventId })
        .delete()
    }

    return result
  }
}
