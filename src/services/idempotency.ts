import { Knex } from 'knex'
import { ParsedEvent } from '../types/horizonSync.js'
import { createHash } from 'node:crypto'

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key conflict') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

// In-memory store for idempotent responses (replaces DB for now)
const idempotencyStore = new Map<string, { hash: string; response: unknown }>()

export function hashRequestPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

export async function getIdempotentResponse<T>(key: string, hash: string): Promise<T | null> {
  const entry = idempotencyStore.get(key)
  if (!entry) return null
  if (entry.hash !== hash) throw new IdempotencyConflictError()
  return entry.response as T
}

export async function saveIdempotentResponse(
  key: string,
  hash: string,
  _id: string,
  response: unknown
): Promise<void> {
  idempotencyStore.set(key, { hash, response })
}

export function resetIdempotencyStore(): void {
  idempotencyStore.clear()
}

/**
 * Idempotency Service
 * Handles checking and recording of processed operations to ensure exactly-once execution.
 */
export class IdempotencyService {
  private db: Knex

  constructor(db: Knex) {
    this.db = db
  }

  /**
   * Check if an event has already been processed.
   * 
   * @param eventId - Unique ID of the event
   * @param trx - Optional transaction to use for the check
   * @returns Promise<boolean> - True if already processed
   */
  async isEventProcessed(eventId: string, trx?: Knex.Transaction): Promise<boolean> {
    const query = (trx || this.db)('processed_events')
      .where({ event_id: eventId })
      .first()
    
    const result = await query
    return !!result
  }

  /**
   * Mark an event as processed in the database.
   * MUST be called within a transaction that includes the business logic operations.
   * 
   * @param event - The parsed event being processed
   * @param trx - Transaction to use for recording
   */
  async markEventProcessed(event: ParsedEvent, trx: Knex.Transaction): Promise<void> {
    await trx('processed_events').insert({
      event_id: event.eventId,
      transaction_hash: event.transactionHash,
      event_index: event.eventIndex,
      ledger_number: event.ledgerNumber,
      processed_at: new Date(),
      created_at: new Date()
    })
  }

  /**
   * General-purpose idempotency check for API requests.
   * Checks the idempotency_keys table.
   * 
   * @param key - The idempotency key provided by the client
   * @returns Promise<any | null> - The stored response if found, null otherwise
   */
  async getStoredResponse(key: string): Promise<any | null> {
    const record = await this.db('idempotency_keys')
      .where({ key })
      .first()
    
    return record ? record.response : null
  }

  /**
   * Store a response for a given idempotency key.
   * 
   * @param key - The idempotency key
   * @param response - The response payload to store
   * @param trx - Optional transaction
   */
  async storeResponse(key: string, response: any, trx?: Knex.Transaction): Promise<void> {
    await (trx || this.db)('idempotency_keys').insert({
      key,
      response: typeof response === 'string' ? response : JSON.stringify(response),
      created_at: new Date()
    })
  }
}
