import { db } from '../db/index.js'
import { dispatchWebhookEvent } from './webhooks.js'
import { ETLBatchRepository } from '../repositories/etlBatchRepository.js'
import { isPaused } from './pauseStore.js'

const MAX_ATTEMPTS = 5

/**
 * Claims unprocessed outbox rows using SKIP LOCKED,
 * dispatches them to webhook delivery and ETL enqueue,
 * and marks them processed.
 *
 * When the global webhook-delivery pause flag is active the relay returns 0
 * immediately, leaving all outbox rows untouched for later replay.
 */
export async function relayOutboxBatch(batchSize = 50): Promise<number> {
  if (isPaused()) {
    return 0
  }
  return await db.transaction(async (trx) => {
    // Claim unprocessed outbox rows (SKIP LOCKED)
    const rows = await trx('vault_outbox')
      .where('processed', false)
      .andWhere('attempts', '<', MAX_ATTEMPTS)
      .orderBy('created_at', 'asc')
      .limit(batchSize)
      .forUpdate()
      .skipLocked()

    if (rows.length === 0) {
      return 0
    }

    const etlRepo = new ETLBatchRepository(trx)

    for (const row of rows) {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
      const attempts = row.attempts + 1

      try {
        // 1. Dispatch Webhook
        await dispatchWebhookEvent(payload)

        // 2. Dispatch ETL Enqueue
        try {
          await etlRepo.create(payload.eventId)
        } catch (etlError: any) {
          // If the batch already exists, it is expected due to idempotency
          console.warn(`[OutboxRelay] ETL batch ${payload.eventId} already exists:`, etlError?.message)
        }

        // 3. Mark processed
        await trx('vault_outbox')
          .where('id', row.id)
          .update({
            processed: true,
            attempts,
            processed_at: new Date(),
            last_error: null,
          })

      } catch (err: any) {
        const errorMsg = err?.message || 'Unknown relay error'
        console.error(`[OutboxRelay] Failed to relay outbox row ${row.id}:`, errorMsg)

        if (attempts >= MAX_ATTEMPTS) {
          // Route to dead letter state (processed = true, and save error)
          await trx('vault_outbox')
            .where('id', row.id)
            .update({
              processed: true,
              attempts,
              last_error: `Exceeded max attempts. Last error: ${errorMsg}`,
              processed_at: new Date(),
            })
        } else {
          // Update attempts and save last error to retry next time
          await trx('vault_outbox')
            .where('id', row.id)
            .update({
              attempts,
              last_error: errorMsg,
            })
        }
      }
    }

    return rows.length
  })
}
