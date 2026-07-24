import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { CheckpointStore } from '../services/checkpointStore.js'
import { HorizonCheckpoint } from '../types/horizonSync.js'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeCheckpointRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 1,
    contract_address: 'CABC123',
    last_ledger: 1000,
    last_paging_token: 'tok-1000',
    updated_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    created_at: new Date('2026-01-01T00:00:00Z').toISOString(),
    ...overrides,
  }
}

function makeMockDb(queryBuilder: Partial<Record<string, jest.Mock>> = {}) {
  const qb: any = {
    where: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(null),
    insert: jest.fn<any>().mockReturnThis(),
    onConflict: jest.fn<any>().mockReturnThis(),
    merge: jest.fn<any>().mockResolvedValue(undefined),
    delete: jest.fn<any>().mockResolvedValue(1),
    orderBy: jest.fn<any>().mockResolvedValue([]),
    ...queryBuilder,
  }

  const db: any = jest.fn<any>().mockReturnValue(qb)
  db._qb = qb
  return db
}

// ── getCheckpoint ─────────────────────────────────────────────────────────────

describe('CheckpointStore.getCheckpoint', () => {
  it('returns null when no row exists', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)
    const result = await store.getCheckpoint('CABC123')
    expect(result).toBeNull()
    expect(db).toHaveBeenCalledWith('horizon_checkpoints')
    expect(db._qb.where).toHaveBeenCalledWith({ contract_address: 'CABC123' })
    expect(db._qb.first).toHaveBeenCalled()
  })

  it('returns a mapped checkpoint when a row exists', async () => {
    const row = makeCheckpointRow()
    const db = makeMockDb({ first: jest.fn<any>().mockResolvedValue(row) })
    const store = new CheckpointStore(db)

    const result = await store.getCheckpoint('CABC123')

    expect(result).not.toBeNull()
    expect(result!.id).toBe(1)
    expect(result!.contractAddress).toBe('CABC123')
    expect(result!.lastLedger).toBe(1000)
    expect(result!.lastPagingToken).toBe('tok-1000')
    expect(result!.updatedAt).toBeInstanceOf(Date)
    expect(result!.createdAt).toBeInstanceOf(Date)
  })

  it('maps null paging token correctly', async () => {
    const row = makeCheckpointRow({ last_paging_token: null })
    const db = makeMockDb({ first: jest.fn<any>().mockResolvedValue(row) })
    const store = new CheckpointStore(db)

    const result = await store.getCheckpoint('CABC123')
    expect(result!.lastPagingToken).toBeNull()
  })

  it('coerces last_ledger to a number', async () => {
    const row = makeCheckpointRow({ last_ledger: '5000' })
    const db = makeMockDb({ first: jest.fn<any>().mockResolvedValue(row) })
    const store = new CheckpointStore(db)

    const result = await store.getCheckpoint('CABC123')
    expect(typeof result!.lastLedger).toBe('number')
    expect(result!.lastLedger).toBe(5000)
  })
})

// ── getAllCheckpoints ──────────────────────────────────────────────────────────

describe('CheckpointStore.getAllCheckpoints', () => {
  it('returns an empty array when no checkpoints exist', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)
    const result = await store.getAllCheckpoints()
    expect(result).toEqual([])
  })

  it('returns all checkpoints ordered by contract_address', async () => {
    const rows = [
      makeCheckpointRow({ id: 1, contract_address: 'CAAA', last_ledger: 100 }),
      makeCheckpointRow({ id: 2, contract_address: 'CBBB', last_ledger: 200 }),
    ]
    const qb: any = {
      orderBy: jest.fn<any>().mockResolvedValue(rows),
    }
    const db: any = jest.fn<any>().mockReturnValue(qb)

    const store = new CheckpointStore(db)
    const result = await store.getAllCheckpoints()

    expect(result).toHaveLength(2)
    expect(result[0].contractAddress).toBe('CAAA')
    expect(result[1].contractAddress).toBe('CBBB')
    expect(qb.orderBy).toHaveBeenCalledWith('contract_address', 'asc')
  })

  it('maps each row correctly', async () => {
    const rows = [makeCheckpointRow({ id: 5, contract_address: 'CXYZ', last_ledger: 999 })]
    const qb: any = { orderBy: jest.fn<any>().mockResolvedValue(rows) }
    const db: any = jest.fn<any>().mockReturnValue(qb)

    const store = new CheckpointStore(db)
    const [cp] = await store.getAllCheckpoints()

    expect(cp.id).toBe(5)
    expect(cp.contractAddress).toBe('CXYZ')
    expect(cp.lastLedger).toBe(999)
  })
})

// ── upsertCheckpoint ──────────────────────────────────────────────────────────

describe('CheckpointStore.upsertCheckpoint', () => {
  it('inserts with the correct columns', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.upsertCheckpoint('CABC', 2000, 'tok-2000')

    expect(db).toHaveBeenCalledWith('horizon_checkpoints')
    const insertCall = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(insertCall.contract_address).toBe('CABC')
    expect(insertCall.last_ledger).toBe(2000)
    expect(insertCall.last_paging_token).toBe('tok-2000')
    expect(insertCall.updated_at).toBeInstanceOf(Date)
    expect(insertCall.created_at).toBeInstanceOf(Date)
  })

  it('calls onConflict + merge for upsert semantics', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.upsertCheckpoint('CABC', 2000, 'tok-2000')

    expect(db._qb.onConflict).toHaveBeenCalledWith('contract_address')
    expect(db._qb.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        last_ledger: 2000,
        last_paging_token: 'tok-2000',
      }),
    )
  })

  it('uses null as default paging token when omitted', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.upsertCheckpoint('CABC', 3000)

    const insertCall = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(insertCall.last_paging_token).toBeNull()
  })

  it('passes an explicit transaction to the query', async () => {
    // Build a transaction that looks like a Knex query builder
    const trxQb: any = {
      insert: jest.fn<any>().mockReturnThis(),
      onConflict: jest.fn<any>().mockReturnThis(),
      merge: jest.fn<any>().mockResolvedValue(undefined),
    }
    const trx: any = jest.fn<any>().mockReturnValue(trxQb)

    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.upsertCheckpoint('CABC', 1500, 'tok', trx)

    // Should have called the transaction, not db
    expect(trx).toHaveBeenCalledWith('horizon_checkpoints')
    expect(db).not.toHaveBeenCalled()
  })
})

// ── resetCheckpoint ───────────────────────────────────────────────────────────

describe('CheckpointStore.resetCheckpoint', () => {
  it('writes the supplied ledger regardless of current value', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.resetCheckpoint('CABC', 500, 'tok-500')

    const insertCall = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(insertCall.last_ledger).toBe(500)
    expect(insertCall.last_paging_token).toBe('tok-500')
  })

  it('uses null paging token when omitted', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.resetCheckpoint('CABC', 100)

    const insertCall = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(insertCall.last_paging_token).toBeNull()
  })

  it('calls onConflict merge for upsert semantics', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.resetCheckpoint('CABC', 100)

    expect(db._qb.onConflict).toHaveBeenCalledWith('contract_address')
    expect(db._qb.merge).toHaveBeenCalled()
  })
})

// ── deleteCheckpoint ──────────────────────────────────────────────────────────

describe('CheckpointStore.deleteCheckpoint', () => {
  it('calls delete with the correct contract address filter', async () => {
    const db = makeMockDb()
    const store = new CheckpointStore(db)

    await store.deleteCheckpoint('CABC123')

    expect(db).toHaveBeenCalledWith('horizon_checkpoints')
    expect(db._qb.where).toHaveBeenCalledWith({ contract_address: 'CABC123' })
    expect(db._qb.delete).toHaveBeenCalled()
  })

  it('does not throw when deleting a non-existent contract', async () => {
    const db = makeMockDb({ delete: jest.fn<any>().mockResolvedValue(0) })
    const store = new CheckpointStore(db)
    await expect(store.deleteCheckpoint('UNKNOWN')).resolves.toBeDefined()
  })
})
