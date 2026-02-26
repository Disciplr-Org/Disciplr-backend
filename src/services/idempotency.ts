import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { getPgPool } from '../db/pool.js'

interface IdempotencyRecord<T> {
  key: string
  requestHash: string
  response: T
}

const memoryStore = new Map<string, IdempotencyRecord<unknown>>()

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key already exists with a different request payload.')
    this.name = 'IdempotencyConflictError'
  }
}

export const hashRequestPayload = (payload: unknown): string => {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex')
}

export const getIdempotentResponse = async <T>(
  key: string,
  requestHash: string,
): Promise<T | null> => {
  const pool = getPgPool()
  if (pool) {
    const result = await pool.query<{
      request_hash: string
      response: T
    }>('SELECT request_hash, response FROM idempotency_keys WHERE key = $1', [key])

    if (result.rowCount === 0) {
      return null
    }

    const row = result.rows[0]
    if (row.request_hash !== requestHash) {
      throw new IdempotencyConflictError()
    }

    return row.response
  }

  const record = memoryStore.get(key)
  if (!record) {
    return null
  }

  if (record.requestHash !== requestHash) {
    throw new IdempotencyConflictError()
  }

  return record.response as T
}

export const saveIdempotentResponse = async <T>(
  key: string,
  requestHash: string,
  vaultId: string,
  response: T,
  client?: PoolClient,
): Promise<void> => {
  if (client) {
    await client.query(
      'INSERT INTO idempotency_keys (key, request_hash, vault_id, response) VALUES ($1, $2, $3, $4::jsonb)',
      [key, requestHash, vaultId, JSON.stringify(response)],
    )
    return
  }

  const pool = getPgPool()
  if (pool) {
    await pool.query('INSERT INTO idempotency_keys (key, request_hash, vault_id, response) VALUES ($1, $2, $3, $4::jsonb)', [
      key,
      requestHash,
      vaultId,
      JSON.stringify(response),
    ])
    return
  }

  memoryStore.set(key, { key, requestHash, response })
}

export const resetIdempotencyStore = (): void => {
  memoryStore.clear()
}
