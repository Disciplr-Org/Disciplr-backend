import type { Pool, PoolClient } from 'pg'
import { getPgPool } from '../db/pool.js'
import type { PersistedVault } from '../types/vaults.js'
import { AsyncMutex } from '../utils/asyncMutex.js'
import { assertValidVaultCreateResponse } from './vaultValidation.js'

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

/**
 * Thrown when a stored idempotency reservation holds a response that cannot
 * be parsed or does not satisfy the vault-create response shape. This is a
 * server-side data-integrity failure: the stored row is corrupt or was
 * tampered with, so the request fails closed instead of replaying garbage.
 */
export class VaultCreationMalformedResponseError extends Error {
  readonly code = 'IDEMPOTENCY_MALFORMED_RESPONSE'

  constructor(message = 'Stored idempotency response is malformed') {
    super(message)
    this.name = 'VaultCreationMalformedResponseError'
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

export interface IdempotencyActions<V, T> {
  createVault: (client: PoolClient | null) => Promise<V>
  getVault: (client: PoolClient | null, vaultId: string) => Promise<V | null>
  buildResponse: (vault: V) => Promise<T>
}

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
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as T
    } catch {
      throw new VaultCreationMalformedResponseError()
    }
  }
  try {
    assertValidVaultCreateResponse(value)
  } catch {
    throw new VaultCreationMalformedResponseError()
  }
  return value as T
}

async function createInMemory<V extends { id: string }, T>(
  options: CoordinatorOptions,
  actions: IdempotencyActions<V, T>,
): Promise<{ vault: V; response: T; replayed: boolean }> {
  return memoryMutex.runExclusive(async () => {
    const now = (options.now ?? (() => new Date()))().getTime()
    const current = memoryClaims.get(options.key)
    if (current && current.expiresAt > now) {
      assertOwner(current.owner, options.owner)
      if (current.requestHash !== options.requestHash) throw new VaultCreationIdempotencyConflictError()
      if (current.response !== null) {
        return { vault: { id: current.vaultId } as V, response: current.response as T, replayed: true }
      }
      throw new VaultCreationInProgressError()
    }

    let claim = current
    if (!claim) {
      claim = {
        requestHash: options.requestHash,
        owner: options.owner,
        expiresAt: now + effectiveTtl(options.ttlMs),
        response: null,
        vaultId: null,
      }
      memoryClaims.set(options.key, claim)
    } else {
      claim.expiresAt = now + effectiveTtl(options.ttlMs)
    }

    try {
      let vault: V
      if (claim.vaultId) {
        const existing = await actions.getVault(null, claim.vaultId)
        if (!existing) throw new Error('Vault missing during memory replay')
        vault = existing
      } else {
        vault = await actions.createVault(null)
        claim.vaultId = vault.id
      }
      const response = await actions.buildResponse(vault)
      claim.response = response
      return { vault, response, replayed: false }
    } catch (error) {
      if (!claim.vaultId) {
        memoryClaims.delete(options.key)
      } else {
        claim.response = null
      }
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
            response = NULL
      WHERE idempotency_key = $1`,
    [options.key, expiresAt, now],
  )
  return { claimed: true, vaultId: existing.vault_id }
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

export async function createVaultIdempotently<T>(
  options: CoordinatorOptions,
  actions: IdempotencyActions<V, T>,
  poolOverride?: Pool | null,
): Promise<{ vault: V; response: T; replayed: boolean }> {
  const pool = poolOverride === undefined ? getPgPool() : poolOverride
  if (!pool) return createInMemory(options, actions)

  const now = options.now ?? (() => new Date())
  let claim;
  const claimClient = await pool.connect()
  try {
    claim = await claimDurably(claimClient, options)
  } finally {
    claimClient.release()
  }

  if (!claim.claimed) {
    return {
      vault: { id: claim.vaultId } as PersistedVault,
      response: parseResponse<T>(claim.response),
      replayed: true,
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const created = await create(client)
    await completeDurably(client, options.key, created.vault, created.response, now())
    await client.query('COMMIT')
    return { ...created, replayed: false }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    
    // Attempt to clear the pending claim so the user doesn't have to wait for TTL to retry
    const cleanupClient = await pool.connect()
    try {
      await cleanupClient.query(
        `DELETE FROM vault_creation_idempotency WHERE idempotency_key = $1 AND state = 'pending'`,
        [options.key]
      )
    } catch(e) {
      // Ignore cleanup errors
    } finally {
      cleanupClient.release()
    }
    throw error
  } finally {
    client1.release()
  }

  const response = await actions.buildResponse(vault)

  const client2 = await pool.connect()
  try {
    await client2.query('BEGIN')
    await completeDurably(client2, options.key, vault as any, response, now())
    await client2.query('COMMIT')
  } catch (error) {
    await client2.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client2.release()
  }
  
  return { vault, response, replayed: false }
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
