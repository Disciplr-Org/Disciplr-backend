import { Knex } from 'knex'
import { ParsedEvent } from '../types/horizonSync.js'
import { createHash } from 'node:crypto'

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,255}$/

export type KeyValidationResult =
  | { valid: true }
  | { valid: false; error: string; code: 'INVALID_IDEMPOTENCY_KEY' }

export function validateIdempotencyKey(key: string): KeyValidationResult {
  if (!key || !IDEMPOTENCY_KEY_RE.test(key)) {
    return {
      valid: false,
      error: 'Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores.',
      code: 'INVALID_IDEMPOTENCY_KEY',
    }
  }
  return { valid: true }
}

export function scopeIdempotencyKey(userId: string, clientKey: string): string {
  return `${userId}:${clientKey}`
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key conflict') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

// Exported so callers implementing custom storage can signal owner violations.
// Not thrown by the default in-memory or DB-backed implementations —
// key namespacing handles isolation instead.
export class IdempotencyOwnerMismatchError extends Error {
  constructor(message = 'Idempotency key belongs to a different owner') {
    super(message)
    this.name = 'IdempotencyOwnerMismatchError'
  }
}

export interface OwnerContext {
  userId: string | null
  orgId: string | null
}

interface StoreEntry {
  hash: string
  response: unknown
  expiresAt: number
  userId: string | null
  orgId: string | null
}

type PendingIdempotencyRequest = {
  hash: string
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  userId: string | null
  orgId: string | null
}

// In-memory store for idempotent responses (replaces DB for now)
const idempotencyStore = new Map<string, StoreEntry>()
const pendingIdempotencyRequests = new Map<string, PendingIdempotencyRequest>()
let idempotencyTtlMs = Number(process.env.IDEMPOTENCY_TTL_MS ?? 60 * 60 * 1000)

/**
 * Derives a principal-scoped internal key so that two users sharing the same
 * client-supplied key string never see each other's cached responses.
 *
 * Preference order: org-level (API keys) → user-level (JWT) → raw (anonymous).
 * Opaque to the caller; matches the contract documented in docs/idempotency.md.
 */
export function buildInternalKey(clientKey: string, owner?: OwnerContext): string {
  if (!owner) return clientKey
  if (owner.orgId) return `org:${owner.orgId}:${clientKey}`
  if (owner.userId) return `user:${owner.userId}:${clientKey}`
  return clientKey
}

export function hashRequestPayload(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

function pruneExpiredEntries(now = Date.now()): void {
  for (const [key, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(key)
    }
  }
}

export function setIdempotencyTtlMs(ttlMs: number): void {
  idempotencyTtlMs = ttlMs
}

export async function getIdempotentResponse<T>(
  key: string,
  hash: string,
  owner?: OwnerContext,
): Promise<T | null> {
  const internalKey = buildInternalKey(key, owner)
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(internalKey)
  if (pending) {
    if (pending.hash !== hash) throw new IdempotencyConflictError()
    return pending.promise as Promise<T>
  }

  const entry = idempotencyStore.get(internalKey)
  if (!entry) {
    let resolve!: (value: unknown) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })

    pendingIdempotencyRequests.set(internalKey, {
      hash,
      promise,
      resolve,
      reject,
      userId: owner?.userId ?? null,
      orgId: owner?.orgId ?? null,
    })
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
  owner?: OwnerContext,
): Promise<void> {
  const internalKey = buildInternalKey(key, owner)
  pruneExpiredEntries()

  const pending = pendingIdempotencyRequests.get(internalKey)
  if (pending) {
    pendingIdempotencyRequests.delete(internalKey)
    pending.resolve(response)
  }

  idempotencyStore.set(internalKey, {
    hash,
    response,
    expiresAt: Date.now() + idempotencyTtlMs,
    userId: owner?.userId ?? null,
    orgId: owner?.orgId ?? null,
  })
}

export function failPendingIdempotentResponse(
  key: string,
  hash: string,
  error: unknown,
  owner?: OwnerContext,
): void {
  const internalKey = buildInternalKey(key, owner)
  const pending = pendingIdempotencyRequests.get(internalKey)
  if (!pending || pending.hash !== hash) {
    return
  }

  pendingIdempotencyRequests.delete(internalKey)
  pending.reject(error)
}

export function resetIdempotencyStore(): void {
  idempotencyStore.clear()
  pendingIdempotencyRequests.clear()
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
      created_at: new Date(),
    })
  }

  /**
   * General-purpose idempotency check for API requests.
   * Looks up the principal-scoped internal key; user_id / org_id columns
   * are stored for auditing but are not used for access control here —
   * the namespaced key guarantees isolation between principals.
   *
   * @param key - The client-supplied idempotency key
   * @param owner - The authenticated principal making the request
   * @returns Promise<any | null> - The stored response if found, null otherwise
   */
  async getStoredResponse(key: string, owner?: OwnerContext): Promise<any | null> {
    const internalKey = buildInternalKey(key, owner)
    const record = await this.db('idempotency_keys').where({ key: internalKey }).first()
    return record ? record.response : null
  }

  /**
   * Store a response for a given idempotency key, bound to the requesting owner.
   * Stores user_id / org_id for auditing alongside the namespaced key.
   *
   * @param key - The client-supplied idempotency key
   * @param response - The response payload to store
   * @param owner - The authenticated principal to bind the key to
   * @param trx - Optional transaction
   */
  async storeResponse(
    key: string,
    response: any,
    owner?: OwnerContext,
    trx?: Knex.Transaction,
  ): Promise<void> {
    const internalKey = buildInternalKey(key, owner)
    await (trx || this.db)('idempotency_keys').insert({
      key: internalKey,
      response: typeof response === 'string' ? response : JSON.stringify(response),
      user_id: owner?.userId ?? null,
      org_id: owner?.orgId ?? null,
      created_at: new Date(),
    })
  }
}
