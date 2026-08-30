/**
 * Focused tests for the durable (DB-backed) path of createVaultIdempotently
 * and for the reclaim-on-expired-pending-row edge case.
 *
 * Uses an in-process FakeClient / FakePool so no real database is needed.
 * Refs #1520
 */
import {
  createVaultIdempotently,
  resetVaultCreationIdempotency,
  VaultCreationIdempotencyConflictError,
  VaultCreationInProgressError,
  VaultCreationMalformedResponseError,
  VaultCreationOwnerError,
  type IdempotencyOwner,
} from './vaultCreationIdempotency.js'
import type { PoolClient } from 'pg'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const owner: IdempotencyOwner = { userId: 'u-1', orgId: 'o-1' }

const validStoredResponse = {
  vault: { id: 'vault-db-1', amount: '500', status: 'draft' },
  onChain: {
    payload: { method: 'create_vault', contractId: 'C' + 'A'.repeat(55), args: {} },
    submission: { attempted: false, status: 'not_requested' },
  },
  idempotency: { key: 'k', replayed: false },
}

function makeActions(vaultId = 'vault-db-1', response: unknown = validStoredResponse) {
  return {
    createVault: jest.fn().mockResolvedValue({ id: vaultId }),
    getVault: jest.fn().mockImplementation(async (_c: unknown, id: string) => ({ id })),
    buildResponse: jest.fn().mockResolvedValue(response),
  }
}

/**
 * Minimal in-process stand-in for pg.Pool/PoolClient.
 * Each call to pool.connect() returns a fresh independent client instance
 * so multi-connect scenarios (claim + write + cleanup) work correctly.
 */
class FakeClient {
  rowsForSelect: Array<Record<string, unknown>> = []
  insertRowCount = 1
  updateRowCount = 1
  deleteRowCount = 0
  queries: string[] = []
  released = false

  async query(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }> {
    this.queries.push(sql.trim())
    const t = sql.trim().toUpperCase()
    if (/^BEGIN/.test(t) || /^COMMIT/.test(t) || /^ROLLBACK/.test(t)) {
      return { rowCount: null, rows: [] }
    }
    if (/INSERT INTO VAULT_CREATION_IDEMPOTENCY/.test(t)) {
      if (this.insertRowCount === 0) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [{ idempotency_key: String(params[0]) }] }
    }
    if (/SELECT IDEMPOTENCY_KEY/.test(t)) {
      return { rowCount: this.rowsForSelect.length, rows: this.rowsForSelect }
    }
    if (/UPDATE VAULT_CREATION_IDEMPOTENCY/.test(t)) {
      return { rowCount: this.updateRowCount, rows: [] }
    }
    if (/DELETE FROM VAULT_CREATION_IDEMPOTENCY/.test(t)) {
      return { rowCount: this.deleteRowCount, rows: [] }
    }
    throw new Error(`Unexpected SQL in FakeClient: ${sql}`)
  }

  release(): void {
    this.released = true
  }
}

/** Each connect() call returns the same shared client (single-client pool). */
function singleClientPool(client: FakeClient): any {
  return { connect: async () => client as unknown as PoolClient }
}

/**
 * Multi-client pool: the first connect() returns `claimClient`, subsequent
 * ones return `writeClient`. Models the real two-connection flow in the
 * durable path (one connection claims, another writes + completes).
 */
function multiClientPool(claimClient: FakeClient, writeClient: FakeClient): any {
  let calls = 0
  return {
    connect: async () => {
      calls++
      return (calls === 1 ? claimClient : writeClient) as unknown as PoolClient
    },
  }
}

const completedRow = (response: unknown = validStoredResponse, overrides: Record<string, unknown> = {}) => ({
  idempotency_key: 'u-1:k',
  request_hash: 'hash-1',
  user_id: 'u-1',
  org_id: 'o-1',
  state: 'completed',
  vault_id: 'vault-db-1',
  response: typeof response === 'string' ? response : JSON.stringify(response),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
})

const pendingRow = (overrides: Record<string, unknown> = {}) => ({
  idempotency_key: 'u-1:k',
  request_hash: 'hash-1',
  user_id: 'u-1',
  org_id: 'o-1',
  state: 'pending',
  vault_id: null,
  response: null,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  ...overrides,
})

// ─── Tests ───────────────────────────────────────────────────────────────────

beforeEach(() => resetVaultCreationIdempotency())

describe('durable path — first write', () => {
  test('creates vault once, commits, and returns replayed=false', async () => {
    const claimClient = new FakeClient()
    const writeClient = new FakeClient()
    const pool = multiClientPool(claimClient, writeClient)
    const actions = makeActions()

    const result = await createVaultIdempotently(
      { key: 'u-1:k', requestHash: 'hash-1', owner },
      actions,
      pool,
    )

    expect(result.replayed).toBe(false)
    expect(result.vault).toMatchObject({ id: 'vault-db-1' })
    expect(actions.createVault).toHaveBeenCalledTimes(1)
    expect(actions.buildResponse).toHaveBeenCalledTimes(1)
    // COMMIT must have been issued on the write client
    expect(writeClient.queries.some(q => /^COMMIT/.test(q.toUpperCase()))).toBe(true)
    expect(writeClient.released).toBe(true)
  })

  test('releases the claim client even when it errors during claim', async () => {
    const client = new FakeClient()
    // Force the SELECT after failed INSERT to return nothing — simulates a
    // race where the row disappears before the SELECT FOR UPDATE runs.
    client.insertRowCount = 0
    client.rowsForSelect = []
    const pool = singleClientPool(client)
    const actions = makeActions()

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, actions, pool),
    ).rejects.toThrow('disappeared')
    expect(client.released).toBe(true)
  })
})

describe('durable path — replay completed reservation', () => {
  test('returns stored response with replayed=true, skips createVault', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [completedRow()]
    const pool = singleClientPool(claimClient)
    const actions = makeActions()

    const result = await createVaultIdempotently(
      { key: 'u-1:k', requestHash: 'hash-1', owner },
      actions,
      pool,
    )

    expect(result.replayed).toBe(true)
    expect(result.response).toEqual(validStoredResponse)
    expect(actions.createVault).not.toHaveBeenCalled()
    expect(actions.buildResponse).not.toHaveBeenCalled()
  })

  test('fails closed when the stored response is not valid JSON', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [completedRow('{not: json')]
    const pool = singleClientPool(claimClient)

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, makeActions(), pool),
    ).rejects.toBeInstanceOf(VaultCreationMalformedResponseError)
  })

  test('fails closed when stored response violates the response shape', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [completedRow({ vault: null, onChain: null })]
    const pool = singleClientPool(claimClient)

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, makeActions(), pool),
    ).rejects.toBeInstanceOf(VaultCreationMalformedResponseError)
  })
})

describe('durable path — conflict and owner invariants', () => {
  test('throws VaultCreationIdempotencyConflictError when request hash differs from stored row', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [completedRow(validStoredResponse, { request_hash: 'hash-OTHER' })]
    const pool = singleClientPool(claimClient)

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, makeActions(), pool),
    ).rejects.toBeInstanceOf(VaultCreationIdempotencyConflictError)
  })

  test('throws VaultCreationOwnerError when user_id differs from stored row', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [completedRow(validStoredResponse, { user_id: 'u-ATTACKER' })]
    const pool = singleClientPool(claimClient)

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, makeActions(), pool),
    ).rejects.toBeInstanceOf(VaultCreationOwnerError)
  })

  test('throws VaultCreationInProgressError when pending row is not yet expired', async () => {
    const claimClient = new FakeClient()
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [pendingRow()]
    const pool = singleClientPool(claimClient)

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, makeActions(), pool),
    ).rejects.toBeInstanceOf(VaultCreationInProgressError)
  })
})

describe('durable path — stale pending reclaim', () => {
  test('reclaims an expired pending row and creates the vault', async () => {
    const claimClient = new FakeClient()
    // INSERT conflicts → SELECT finds an expired pending row
    claimClient.insertRowCount = 0
    claimClient.rowsForSelect = [
      pendingRow({ expires_at: new Date(Date.now() - 1_000).toISOString() }),
    ]
    const writeClient = new FakeClient()
    let connectCalls = 0
    const pool = {
      connect: async () => {
        connectCalls++
        return (connectCalls === 1 ? claimClient : writeClient) as unknown as PoolClient
      },
    }
    const actions = makeActions()

    const result = await createVaultIdempotently(
      { key: 'u-1:k', requestHash: 'hash-1', owner },
      actions,
      pool,
    )

    expect(result.replayed).toBe(false)
    expect(actions.createVault).toHaveBeenCalledTimes(1)
    // UPDATE should have been issued to reclaim the stale pending row
    expect(claimClient.queries.some(q => /UPDATE VAULT_CREATION_IDEMPOTENCY/.test(q.toUpperCase()))).toBe(true)
  })

  test('clears the pending reservation and rethrows when createVault fails', async () => {
    const claimClient = new FakeClient()
    const writeClient = new FakeClient()
    // Track whether cleanup DELETE was attempted
    const cleanupClient = new FakeClient()
    let connectCalls = 0
    const pool = {
      connect: async () => {
        connectCalls++
        if (connectCalls === 1) return claimClient as unknown as PoolClient
        if (connectCalls === 2) return writeClient as unknown as PoolClient
        return cleanupClient as unknown as PoolClient
      },
    }
    const actions = {
      createVault: jest.fn().mockRejectedValue(new Error('db write failed')),
      getVault: jest.fn(),
      buildResponse: jest.fn(),
    }

    await expect(
      createVaultIdempotently({ key: 'u-1:k', requestHash: 'hash-1', owner }, actions, pool),
    ).rejects.toThrow('db write failed')

    // ROLLBACK must have been issued on the write client
    expect(writeClient.queries.some(q => /^ROLLBACK/.test(q.toUpperCase()))).toBe(true)
    // The cleanup connection should have attempted a DELETE
    expect(cleanupClient.queries.some(q => /DELETE FROM VAULT_CREATION_IDEMPOTENCY/.test(q.toUpperCase()))).toBe(true)
    expect(cleanupClient.released).toBe(true)
  })
})
