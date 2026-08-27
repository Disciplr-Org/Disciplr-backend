import type { Pool, PoolClient } from 'pg'
import { getPgPool } from '../db/pool.js'
import type { PersistedVault } from '../types/vaults.js'
import { AsyncMutex } from '../utils/asyncMutex.js'

export interface IdempotencyOwner {
  userId: string | null
  orgId: string | null
}

export interface VaultCreationResponse<T = unknown> {
  vault: PersistedVault
  response: T
}

export class VaultCreationIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT'

  constructor(message = 'Idempotency key was already used with a different request') {
    super(message)
    this.name = 'VaultCreationIdempotencyConflictError'
  }
}

export class VaultCreationInProgressError extends Error {
  readonly code = 'IDEMPOTENCY_IN_PROGRESS'

  constructor(message = 'A vault creation with this idempotency key is still in progress') {
    super(message)
    this.name = 'VaultCreationInProgressError'
  }
}

export class VaultCreationOwnerError extends Error {
  readonly code = 'IDEMPOTENCY_OWNER_MISMATCH'

  constructor(message = 'Idempotency key belongs to a different owner') {
    super(message)
    this.name = 'VaultCreationOwnerError'
  }
}

interface CoordinatorOptions {
  key: string
  requestHash: string
  owner: IdempotencyOwner
  ttlMs?: number
  now?: () => Date
}

interface MemoryClaim {
  requestHash: string
  owner: IdempotencyOwner
  expiresAt: number
  response: unknown | null
  vaultId: string | null
}

export type CreateWithClient<T> = (client: PoolClient | null) => Promise<VaultCreationResponse<T>>

const memoryClaims = new Map<string, MemoryClaim>()
const memoryMutex = new AsyncMutex()

function effectiveTtl(ttlMs?: number): number {
  const configured = ttlMs ?? Number(process.env.VAULT_IDEMPOTENCY_TTL_MS ?? 24 * 60 * 60 * 1000)
  return Math.max(1_000, Number.isFinite(configured) ? configured : 24 * 60 * 60 * 1000)
}

function assertOwner(existing: IdempotencyOwner, requested: IdempotencyOwner): void {
  if (existing.userId !== requested.userId || existing.orgId !== requested.orgId) {
    throw new VaultCreationOwnerError()
  }
}

function parseResponse<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

async function createInMemory<T>(
  options: CoordinatorOptions,
  create: CreateWithClient<T>,
): Promise<VaultCreationResponse<T> & { replayed: boolean }> {
  return memoryMutex.runExclusive(async () => {
    const now = (options.now ?? (() => new Date()))().getTime()
    const current = memoryClaims.get(options.key)
    if (current && current.expiresAt > now) {
      assertOwner(current.owner, options.owner)
      if (current.requestHash !== options.requestHash) throw new VaultCreationIdempotencyConflictError()
      if (current.response !== null) {
        return { vault: { id: current.vaultId } as PersistedVault, response: current.response as T, replayed: true }
      }
      throw new VaultCreationInProgressError()
    }

    const claim: MemoryClaim = {
      requestHash: options.requestHash,
      owner: options.owner,
      expiresAt: now + effectiveTtl(options.ttlMs),
      response: null,
      vaultId: null,
    }
    memoryClaims.set(options.key, claim)
    try {
      const created = await create(null)
      claim.response = created.response
      claim.vaultId = created.vault.id
      return { ...created, replayed: false }
    } catch (error) {
      memoryClaims.delete(options.key)
      throw error
    }
  })
}

async function claimDurably(
  client: PoolClient,
  options: CoordinatorOptions,
): Promise<{ claimed: boolean; response?: unknown; vaultId?: string }> {
  const now = (options.now ?? (() => new Date()))()
  const expiresAt = new Date(now.getTime() + effectiveTtl(options.ttlMs))
  const inserted = await client.query(
    `INSERT INTO vault_creation_idempotency
      (idempotency_key, request_hash, user_id, org_id, state, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5, $6, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING idempotency_key`,
    [options.key, options.requestHash, options.owner.userId, options.owner.orgId, expiresAt, now],
  )
  if (inserted.rowCount === 1) return { claimed: true }

  const existingResult = await client.query(
    `SELECT idempotency_key, request_hash, user_id, org_id, state, vault_id, response, expires_at
       FROM vault_creation_idempotency
      WHERE idempotency_key = $1
      FOR UPDATE`,
    [options.key],
  )
  const existing = existingResult.rows[0]
  if (!existing) {
    throw new Error('Idempotency reservation disappeared before it could be read')
  }
  assertOwner({ userId: existing.user_id ?? null, orgId: existing.org_id ?? null }, options.owner)
  if (existing.request_hash !== options.requestHash) throw new VaultCreationIdempotencyConflictError()
  if (existing.state === 'completed') {
    return { claimed: false, response: existing.response, vaultId: existing.vault_id }
  }
  if (existing.state === 'pending' && new Date(existing.expires_at).getTime() > now.getTime()) {
    throw new VaultCreationInProgressError()
  }

  // A stale pending row can be reclaimed, but its fingerprint and owner stay
  // immutable. This prevents an expired key from becoming a cross-owner key.
  await client.query(
    `UPDATE vault_creation_idempotency
        SET state = 'pending', expires_at = $2, updated_at = $3,
            response = NULL, vault_id = NULL
      WHERE idempotency_key = $1`,
    [options.key, expiresAt, now],
  )
  return { claimed: true }
}

async function completeDurably<T>(
  client: PoolClient,
  key: string,
  vault: PersistedVault,
  response: T,
  now: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE vault_creation_idempotency
        SET state = 'completed', vault_id = $2, response = $3, completed_at = $4, updated_at = $4
      WHERE idempotency_key = $1 AND state = 'pending'`,
    [key, vault.id, JSON.stringify(response), now],
  )
  if (result.rowCount !== 1) throw new Error('Idempotency reservation was not completed')
}

/**
 * Execute vault creation under one durable idempotency reservation.
 *
 * The reservation, vault rows, milestone rows, and final response commit in
 * one PostgreSQL transaction. A concurrent insert blocks on the unique key;
 * after the first transaction commits it reads the stored response and never
 * creates a second vault. Expired pending claims can be reclaimed safely.
 */
export async function createVaultIdempotently<T>(
  options: CoordinatorOptions,
  create: CreateWithClient<T>,
  poolOverride?: Pool | null,
): Promise<VaultCreationResponse<T> & { replayed: boolean }> {
  const pool = poolOverride === undefined ? getPgPool() : poolOverride
  if (!pool) return createInMemory(options, create)

  const client = await pool.connect()
  const now = options.now ?? (() => new Date())
  try {
    await client.query('BEGIN')
    const claim = await claimDurably(client, options)
    if (!claim.claimed) {
      await client.query('COMMIT')
      return {
        vault: { id: claim.vaultId } as PersistedVault,
        response: parseResponse<T>(claim.response),
        replayed: true,
      }
    }
    const created = await create(client)
    await completeDurably(client, options.key, created.vault, created.response, now())
    await client.query('COMMIT')
    return { ...created, replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

/** Test-only cleanup for the no-database fallback. */
export function resetVaultCreationIdempotency(): void {
  memoryClaims.clear()
}

/** Test-only inspection that avoids exposing internal reservation rows. */
export function getMemoryReservation(key: string): { state: 'pending' | 'completed' | 'expired' | 'missing'; vaultId: string | null } {
  const claim = memoryClaims.get(key)
  if (!claim) return { state: 'missing', vaultId: null }
  if (claim.response === null && claim.expiresAt <= Date.now()) return { state: 'expired', vaultId: claim.vaultId }
  return { state: claim.response === null ? 'pending' : 'completed', vaultId: claim.vaultId }
}
