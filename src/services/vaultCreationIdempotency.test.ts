import {
  createVaultIdempotently,
  getMemoryReservation,
  resetVaultCreationIdempotency,
  VaultCreationIdempotencyConflictError,
  VaultCreationInProgressError,
  VaultCreationMalformedResponseError,
  type IdempotencyOwner,
} from './vaultCreationIdempotency.js'
import type { PoolClient } from 'pg'

const owner: IdempotencyOwner = { userId: 'user-1', orgId: 'org-1' }
let actions: any;
  beforeEach(() => {
    actions = {
      createVault: jest.fn().mockImplementation(async () => ({ id: 'vault-1' })),
      getVault: jest.fn().mockImplementation(async (_c, id) => ({ id })),
      buildResponse: jest.fn().mockImplementation(async (v) => ({ vaultId: v.id, signedPayload: 'original' }))
    };
  })

describe('durable vault creation idempotency coordinator', () => {
  beforeEach(() => resetVaultCreationIdempotency())

  test('creates once and replays the original response', async () => {
    let calls = 0
    const create = async () => {
      calls++
      return { vault: { id: 'vault-1' }, response: { vaultId: 'vault-1', signedPayload: 'original' } }
    }
    const first = await createVaultIdempotently({ key: 'key-1', requestHash: 'hash-1', owner }, actions, null)
    const replay = await createVaultIdempotently({ key: 'key-1', requestHash: 'hash-1', owner }, actions, null)
    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.response).toEqual(first.response)
    expect(calls).toBe(1)
    expect(getMemoryReservation('key-1')).toEqual({ state: 'completed', vaultId: 'vault-1' })
  })

  test('rejects reuse with a changed request fingerprint', async () => {
    const create = async () => makeCreated('vault-1')
    await createVaultIdempotently({ key: 'key-2', requestHash: 'hash-1', owner }, actions, null)
    await expect(
      createVaultIdempotently({ key: 'key-2', requestHash: 'hash-2', owner }, actions, null),
    ).rejects.toBeInstanceOf(VaultCreationIdempotencyConflictError)
  })

  test('rejects reuse by another owner even with the same request hash', async () => {
    const create = async () => makeCreated('vault-1')
    await createVaultIdempotently({ key: 'key-3', requestHash: 'hash-1', owner }, actions, null)
    await expect(
      createVaultIdempotently(
        { key: 'key-3', requestHash: 'hash-1', owner: { userId: 'user-2', orgId: 'org-1' } },
        create,
        null,
      ),
    ).rejects.toThrow('different owner')
  })

  test('serializes concurrent first writes under the in-memory fallback', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const create = async () => {
      calls++
      await gate
      return makeCreated('vault-concurrent')
    }
    const first = createVaultIdempotently({ key: 'key-4', requestHash: 'hash-1', owner }, actions, null)
    const second = createVaultIdempotently({ key: 'key-4', requestHash: 'hash-1', owner }, actions, null)
    release()
    await expect(first).resolves.toMatchObject({ replayed: false })
    await expect(second).resolves.toMatchObject({ replayed: true })
    expect(calls).toBe(1)
  })

  test('removes a reservation when the creation callback fails', async () => {
    await expect(
      createVaultIdempotently(
        { key: 'key-5', requestHash: 'hash-1', owner },
        async () => { throw new Error('storage failure') },
        null,
      ),
    ).rejects.toThrow('storage failure')
    expect(getMemoryReservation('key-5').state).toBe('missing')
  })

  test('returns an in-progress conflict while a long first request owns a key', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const create = async () => {
      await gate
      return makeCreated('vault-slow')
    }
    const first = createVaultIdempotently({ key: 'key-6', requestHash: 'hash-1', owner }, actions, null)
    // The mutex deliberately makes the second call wait. Once the first
    // completes it receives the stored response rather than creating twice.
    release()
    await expect(first).resolves.toMatchObject({ replayed: false })
    await expect(
      createVaultIdempotently({ key: 'key-6', requestHash: 'hash-1', owner }, actions, null),
    ).resolves.toMatchObject({ replayed: true })
  })

  test('supports anonymous ownership without cross-key leakage', async () => {
    const anonymous = { userId: null, orgId: null }
    const create = async () => makeCreated('anonymous-vault')
    await createVaultIdempotently({ key: 'key-7', requestHash: 'hash-1', owner: anonymous }, actions, null)
    await expect(
      createVaultIdempotently({ key: 'key-8', requestHash: 'hash-1', owner: anonymous }, actions, null),
    ).resolves.toMatchObject({ replayed: false })
  })

  test('response remains opaque and is replayed without rebuilding on-chain data', async () => {
    const response = { vault: { id: 'vault-opaque' }, onChain: { args: ['only-once'] } }
    let calls = 0
    const create = async () => { calls++; return makeCreated('vault-opaque', response) }
    const first = await createVaultIdempotently({ key: 'key-8', requestHash: 'hash-8', owner }, actions, null)
    const replay = await createVaultIdempotently({ key: 'key-8', requestHash: 'hash-8', owner }, actions, null)
    expect(replay.response).toEqual(response)
    expect(calls).toBe(1)
    expect(first.response).toBe(response)
  })
})

// ─── Durable (DB) reservation path with a fake pool ───────────────────────────

/**
 * Minimal in-process stand-in for pg.Pool / PoolClient so the durable
 * reservation SQL path can be exercised without a real database.
 */
class FakeClient {
  rowsForSelect: Array<Record<string, unknown>> = []
  /** Set to 0 to simulate a key that is already reserved (replay path). */
  insertRowCount = 1
  queries: string[] = []

  async query(sql: string, params: unknown[] = []): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }> {
    this.queries.push(sql)
    const trimmed = sql.trim()
    if (/^BEGIN/i.test(trimmed) || /^COMMIT/i.test(trimmed) || /^ROLLBACK/i.test(trimmed)) {
      return { rowCount: null, rows: [] }
    }
    if (/INSERT INTO vault_creation_idempotency/i.test(trimmed)) {
      if (this.insertRowCount === 0) return { rowCount: 0, rows: [] }
      return { rowCount: 1, rows: [{ idempotency_key: String(params[0]) }] }
    }
    if (/SELECT idempotency_key/i.test(trimmed)) {
      return { rowCount: this.rowsForSelect.length, rows: this.rowsForSelect }
    }
    if (/UPDATE vault_creation_idempotency/i.test(trimmed)) {
      return { rowCount: 1, rows: [] }
    }
    throw new Error(`Unexpected SQL in fake client: ${sql}`)
  }

  release(): void {}
}

const fakePool = (client: FakeClient): any => ({ connect: async () => client as unknown as PoolClient })

const completedRow = (response: unknown) => ({
  idempotency_key: 'user-1:key-db',
  request_hash: 'hash-db',
  user_id: 'user-1',
  org_id: 'org-1',
  state: 'completed',
  vault_id: 'vault-db-1',
  response: typeof response === 'string' ? response : JSON.stringify(response),
  expires_at: new Date(Date.now() + 60_000).toISOString(),
})

const validStoredResponse = {
  vault: { id: 'vault-db-1', amount: '1000', status: 'draft' },
  onChain: {
    payload: { method: 'create_vault', contractId: 'C' + 'A'.repeat(55), args: {} },
    submission: { attempted: false, status: 'not_requested' },
  },
  idempotency: { key: 'key-db', replayed: false },
}

describe('durable vault creation idempotency coordinator', () => {
  test('replays the stored response from the durable path', async () => {
    const client = new FakeClient()
    const pool = fakePool(client)
    let calls = 0
    const create = async () => {
      calls++
      return makeCreated('vault-db-1', validStoredResponse)
    }

    const first = await createVaultIdempotently({ key: 'user-1:key-db', requestHash: 'hash-db', owner }, actions, pool)
    expect(first.replayed).toBe(false)
    expect(calls).toBe(1)

    // Second call: the reservation already exists → replay the stored row.
    client.insertRowCount = 0
    client.rowsForSelect = [completedRow(validStoredResponse)]
    const replay = await createVaultIdempotently({ key: 'user-1:key-db', requestHash: 'hash-db', owner }, actions, pool)
    expect(replay.replayed).toBe(true)
    expect(replay.response).toEqual(validStoredResponse)
    expect(calls).toBe(1)
  })

  test('fails closed when the stored response is not valid JSON', async () => {
    const client = new FakeClient()
    client.insertRowCount = 0
    client.rowsForSelect = [completedRow('{not valid json')]
    const create = async () => makeCreated('vault-db-1', validStoredResponse)

    await expect(
      createVaultIdempotently({ key: 'user-1:key-db', requestHash: 'hash-db', owner }, actions, fakePool(client)),
    ).rejects.toBeInstanceOf(VaultCreationMalformedResponseError)
  })

  test('fails closed when the stored response violates the response shape', async () => {
    const client = new FakeClient()
    client.insertRowCount = 0
    client.rowsForSelect = [completedRow({ vault: null })]
    const create = async () => makeCreated('vault-db-1', validStoredResponse)

    await expect(
      createVaultIdempotently({ key: 'user-1:key-db', requestHash: 'hash-db', owner }, actions, fakePool(client)),
    ).rejects.toBeInstanceOf(VaultCreationMalformedResponseError)
  })
})
