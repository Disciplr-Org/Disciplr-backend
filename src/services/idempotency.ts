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
const idempotencyStore = new Map<string, { hash: string; response: unknown; expiresAt: number }>()
const inFlightRequests = new Map<string, { hash: string; promise: Promise<unknown> }>()
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,255}$/
const DEFAULT_IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000

const resolveDefaultTtlMs = (): number => {
  const configured = Number(process.env.IDEMPOTENCY_TTL_MS)
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured)
  }
  return DEFAULT_IDEMPOTENCY_TTL_MS
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item))
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    )
  }
  return value
}

export function validateIdempotencyKey(key: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(key)
}

export function hashRequestPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex')
}

export async function getIdempotentResponse<T>(
  key: string,
  hash: string,
  now: number = Date.now(),
): Promise<T | null> {
  const entry = idempotencyStore.get(key)
  if (!entry) return null
  if (entry.expiresAt <= now) {
    idempotencyStore.delete(key)
    return null
  }
  if (entry.hash !== hash) throw new IdempotencyConflictError()
  return entry.response as T
}

export async function saveIdempotentResponse(
  key: string,
  hash: string,
  _id: string,
  response: unknown,
  ttlMs: number = resolveDefaultTtlMs(),
): Promise<void> {
  idempotencyStore.set(key, { hash, response, expiresAt: Date.now() + ttlMs })
}

export async function runIdempotentRequest<T>(
  key: string,
  hash: string,
  producer: () => Promise<T>,
): Promise<{ response: T; replayed: boolean }> {
  const stored = await getIdempotentResponse<T>(key, hash)
  if (stored) {
    return { response: stored, replayed: true }
  }

  const inFlight = inFlightRequests.get(key)
  if (inFlight) {
    if (inFlight.hash !== hash) {
      throw new IdempotencyConflictError()
    }
    return { response: await inFlight.promise as T, replayed: true }
  }

  const promise = (async () => {
    const response = await producer()
    await saveIdempotentResponse(key, hash, key, response)
    return response
  })()
  inFlightRequests.set(key, { hash, promise })

  try {
    return { response: await promise, replayed: false }
  } finally {
    if (inFlightRequests.get(key)?.promise === promise) {
      inFlightRequests.delete(key)
    }
  }
}

export function resetIdempotencyStore(): void {
  idempotencyStore.clear()
  inFlightRequests.clear()
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
