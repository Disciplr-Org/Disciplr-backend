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
  if (await isPaused()) {
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

/**
 * Default maximum events to replay per call.
 */
export const DEFAULT_REPLAY_BATCH_SIZE = 200

/**
 * Maximum events allowed per single replay request.
 */
export const MAX_REPLAY_BATCH_SIZE = 500

/**
 * Result returned by {@link replayForVault}.
 */
export interface ReplayForVaultResult {
  /** Number of events successfully dispatched in this batch. */
  count: number
  /** Whether there are more outbox events available for this vault beyond this page. */
  hasMore: boolean
}

/**
 * Replays outbox events for a single vault to an optional target subscriber.
 *
 * This function fetches events in bounded batches (controlled by `limit`) to
 * prevent a single replay request from holding the HTTP connection open for an
 * unbounded duration on high-activity vaults.  Uses the same bounded,
 * concurrency-aware dispatch path (`dispatchWebhookEvent`) as the regular
 * outbox relay (`relayOutboxBatch`).
 *
 * Each event is dispatched independently so a single failing delivery does not
 * block the remaining events in the batch.
 *
 * Preserves the original event ordering (by created_at asc) and does NOT
 * modify the outbox state.
 *
 * @param vaultId    - The vault whose outbox events should be replayed.
 * @param subscriberId - Optional – when provided, only replay events to this subscriber.
 * @param limit      - Maximum number of events to fetch and dispatch (default 200, max 500).
 * @param offset     - Number of events to skip for pagination (default 0).
 */
export async function replayForVault(
  vaultId: string,
  subscriberId?: string,
  limit: number = DEFAULT_REPLAY_BATCH_SIZE,
  offset: number = 0,
): Promise<ReplayForVaultResult> {
  // Clamp to max and ensure positive
  const safeLimit = Math.min(Math.max(1, limit), MAX_REPLAY_BATCH_SIZE)
  const safeOffset = Math.max(0, offset)

  // Fetch one extra row to determine if there are more pages
  const rows = await db('vault_outbox')
    .whereRaw("payload->'data'->>'vaultId' = ?", [vaultId])
    .orderBy('created_at', 'asc')
    .limit(safeLimit + 1)
    .offset(safeOffset)

  const hasMore = rows.length > safeLimit
  const batch = hasMore ? rows.slice(0, safeLimit) : rows

  let dispatchedCount = 0

  for (const row of batch) {
    try {
      const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
      await dispatchWebhookEvent(payload, subscriberId)
      dispatchedCount++
    } catch (err: any) {
      // Log but continue — one failure should not abort the entire replay
      console.error(
        `[OutboxRelay] replayForVault: failed to dispatch outbox row ${row.id}:`,
        err?.message ?? 'Unknown error',
      )
    }
  }

  return { count: dispatchedCount, hasMore }
}

