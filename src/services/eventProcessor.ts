import { Knex } from 'knex'
import { ParsedEvent, ProcessorConfig, ProcessingResult, BatchProcessingResult, VaultEventPayload, MilestoneEventPayload, ValidationEventPayload } from '../types/horizonSync.js'
import { retryWithBackoff, isRetryable } from '../utils/retry.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { IdempotencyService } from './idempotency.js'
import { dispatchWebhookEvent, VAULT_LIFECYCLE_EVENTS } from './webhooks.js'
import { setEventThroughput } from '../routes/metrics.js'

/** Extract organization_id from the vault referenced in the event payload. */
async function resolveOrganizationId(db: Knex, payload: VaultEventPayload): Promise<string> {
  if (!payload.vaultId) return ''
  const vault = await db('vaults').where({ id: payload.vaultId }).select('organization_id').first()
  return (vault as { organization_id?: string } | undefined)?.organization_id ?? ''
}

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
   * Return the configured batch size, defaulting to 50.
   */
  getBatchSize(): number {
    return this.config.batchSize ?? 50
  }

  /**
   * Process events in a batched, transactional path.
   *
   * 1. Bulk dedupe check: all event IDs queried in a single round-trip.
   * 2. Already-processed events are skipped.
   * 3. Remaining events are routed inside one transaction.
   * 4. Processed events are bulk-inserted at the end of the transaction.
   *
   * If the transaction fails mid-batch nothing is committed — idempotency
   * guarantees that a retry will not double-apply any event.
   */
  async processBatch(events: ParsedEvent[]): Promise<BatchProcessingResult> {
    const startTime = Date.now()
    const total = events.length
    const results: ProcessingResult[] = []
    let succeeded = 0
    let failed = 0
    let skipped = 0

    if (total === 0) {
      const durationMs = Date.now() - startTime
      return { total, succeeded, failed, skipped, durationMs, results }
    }

    try {
      // 1. Bulk dedupe
      const processedIds = await this.idempotency.areEventsProcessed(
        events.map(e => e.eventId)
      )

      const newEvents: ParsedEvent[] = []
      for (const event of events) {
        if (processedIds.has(event.eventId)) {
          skipped++
          results.push({ success: true, eventId: event.eventId })
        } else {
          newEvents.push(event)
        }
      }

      if (newEvents.length > 0) {
        // 2. Process new events inside a single transaction
        const processed = await this.processNewEventsBatch(newEvents)
        succeeded += processed.succeeded
        failed += processed.failed
        results.push(...processed.results)
      }

      const durationMs = Date.now() - startTime

      // Report throughput metric (events per second)
      if (durationMs > 0) {
        try {
          setEventThroughput((succeeded + skipped) / (durationMs / 1000))
        } catch {
          // metric reporting is best-effort
        }
      }

      return { total, succeeded, failed, skipped, durationMs, results }
    } catch (error) {
      const durationMs = Date.now() - startTime
      for (const event of events) {
        const alreadyDone = results.some(r => r.eventId === event.eventId)
        if (!alreadyDone) {
          failed++
          results.push({
            success: false,
            eventId: event.eventId,
            error: error instanceof Error ? error.message : 'Unknown batch error',
          })
        }
      }
      return { total, succeeded, failed, skipped, durationMs, results }
    }
  }

  private async processNewEventsBatch(
    events: ParsedEvent[],
  ): Promise<{ succeeded: number; failed: number; results: ProcessingResult[] }> {
    const trx = await this.db.transaction()
    let succeeded = 0
    let failed = 0
    const results: ProcessingResult[] = []

    try {
      for (const event of events) {
        try {
          await this.routeEvent(event, trx)
          succeeded++
          results.push({ success: true, eventId: event.eventId })
        } catch (routeError) {
          failed++
          const errorMessage = routeError instanceof Error ? routeError.message : 'Unknown error'
          results.push({
            success: false,
            eventId: event.eventId,
            error: errorMessage,
          })
        }
      }

      // Bulk mark all attempted events as processed (both succeeded and failed)
      // so that re-delivery on retry does not re-apply them.
      await this.idempotency.markEventsProcessed(
        events.map(e => ({
          eventId: e.eventId,
          transactionHash: e.transactionHash,
          eventIndex: e.eventIndex,
          ledgerNumber: e.ledgerNumber,
        })),
        trx,
      )

      // Write outbox events for vault lifecycle events
      for (const event of events) {
        if (VAULT_LIFECYCLE_EVENTS.has(event.eventType)) {
          try {
            const vaultPayload = event.payload as VaultEventPayload
            const organizationId = await resolveOrganizationId(trx, vaultPayload)
            await trx('vault_outbox').insert({
              event_id: event.eventId,
              event_type: event.eventType,
              payload: JSON.stringify({
                eventId: event.eventId,
                eventType: event.eventType,
                timestamp: new Date().toISOString(),
                data: event.payload,
                organizationId,
              }),
              processed: false,
              attempts: 0,
              created_at: new Date(),
            })
          } catch (outboxError) {
            console.error('[EventProcessor] outbox insert failed for event', event.eventId, outboxError)
          }
        }
      }

      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }

    return { succeeded, failed, results }
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
      }).catch((err) => {
        console.error('[EventProcessor] audit log write failed (event_processed):', err)
      })



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
      }).catch((err) => {
        console.error('[EventProcessor] audit log write failed (event_processing_failed):', err)
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

      // Write to outbox table atomically for vault lifecycle events
      if (VAULT_LIFECYCLE_EVENTS.has(event.eventType)) {
        const vaultPayload = event.payload as VaultEventPayload
        const organizationId = await resolveOrganizationId(trx, vaultPayload)
        await trx('vault_outbox').insert({
          event_id: event.eventId,
          event_type: event.eventType,
          payload: JSON.stringify({
            eventId: event.eventId,
            eventType: event.eventType,
            timestamp: new Date().toISOString(),
            data: event.payload,
            organizationId,
          }),
          processed: false,
          attempts: 0,
          created_at: new Date(),
        })
      }

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
