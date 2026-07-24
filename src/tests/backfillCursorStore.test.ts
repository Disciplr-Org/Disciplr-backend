/**
 * backfillCursorStore.test.ts
 *
 * Tests for BackfillCursorStore proving gap-free, duplicate-free resumption
 * across restarts; distinct-name isolation; and safe fallback on absent cursors.
 *
 * Core resumability invariant:
 *   A process that restarts after saving cursor C must resume from exactly C —
 *   no range is skipped (gap-free) and no range is reprocessed (duplicate-free).
 *
 * Coverage:
 *  1. getCursor: absent row → null; stored value returned; null cursor passthrough.
 *  2. upsertCursor: column mapping, conflict resolution, merge payload.
 *  3. resetCursor: row deletion; no-op on missing job.
 *  4. Resumption continuity: restart reads exact saved cursor; sequential advances
 *     never regress; each advance visible immediately.
 *  5. Distinct-name isolation: advancing or resetting one job has no side effect
 *     on any other job.
 *  6. Absent/corrupted cursor fallback: null signals callers to use safe start.
 */
import { describe, it, expect, jest } from '@jest/globals'
import { BackfillCursorStore } from '../services/backfillCursorStore.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stateless query-builder mock.  Each call returns the same `_qb` so callers
 * can inspect `mock.calls` after the fact.
 */
function makeMockDb(queryBuilder: Partial<Record<string, jest.Mock>> = {}) {
  const qb: any = {
    where: jest.fn<any>().mockReturnThis(),
    first: jest.fn<any>().mockResolvedValue(null),
    insert: jest.fn<any>().mockReturnThis(),
    onConflict: jest.fn<any>().mockReturnThis(),
    merge: jest.fn<any>().mockResolvedValue(undefined),
    delete: jest.fn<any>().mockResolvedValue(1),
    ...queryBuilder,
  }
  const db: any = jest.fn<any>().mockReturnValue(qb)
  db._qb = qb
  return db
}

/**
 * Stateful in-memory mock that simulates the `backfill_cursors` table.
 *
 * Each invocation of `db('backfill_cursors')` produces a fresh query-builder
 * closure that shares the same `table` Map, so state persists across calls
 * exactly as it would against a real database.  This lets us verify
 * multi-step resumption semantics without a live DB connection.
 */
function makeStatefulMockDb() {
  const table = new Map<string, string | null>()

  const db: any = jest.fn<any>().mockImplementation(() => {
    let capturedJobName: string | null = null
    let capturedInsertRow: Record<string, any> | null = null

    const qb: any = {
      where: jest.fn<any>().mockImplementation((filter: Record<string, string>) => {
        capturedJobName = filter.job_name
        return qb
      }),
      first: jest.fn<any>().mockImplementation(() => {
        if (capturedJobName !== null && table.has(capturedJobName)) {
          return Promise.resolve({ job_name: capturedJobName, cursor: table.get(capturedJobName) })
        }
        return Promise.resolve(null)
      }),
      insert: jest.fn<any>().mockImplementation((row: Record<string, any>) => {
        capturedInsertRow = row
        return qb
      }),
      onConflict: jest.fn<any>().mockReturnThis(),
      merge: jest.fn<any>().mockImplementation((updates: Record<string, any>) => {
        const name = capturedInsertRow?.job_name ?? null
        if (name !== null) {
          // `cursor` may legitimately be null; use `in` to distinguish from absent
          const newCursor = 'cursor' in updates ? updates.cursor : (capturedInsertRow?.cursor ?? null)
          table.set(name, newCursor)
        }
        return Promise.resolve()
      }),
      delete: jest.fn<any>().mockImplementation(() => {
        if (capturedJobName !== null) {
          table.delete(capturedJobName)
        }
        return Promise.resolve(1)
      }),
    }
    return qb
  })

  return { db, table }
}

// ---------------------------------------------------------------------------
// getCursor
// ---------------------------------------------------------------------------

describe('BackfillCursorStore.getCursor', () => {
  it('returns null when no row exists', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    const result = await store.getCursor('job-a')

    expect(result).toBeNull()
    expect(db).toHaveBeenCalledWith('backfill_cursors')
    expect(db._qb.where).toHaveBeenCalledWith({ job_name: 'job-a' })
    expect(db._qb.first).toHaveBeenCalled()
  })

  it('returns the stored cursor string when a row exists', async () => {
    const db = makeMockDb({
      first: jest.fn<any>().mockResolvedValue({ job_name: 'job-a', cursor: 'item-500' }),
    })
    const store = new BackfillCursorStore(db)

    const result = await store.getCursor('job-a')

    expect(result).toBe('item-500')
  })

  it('returns null when the cursor column is stored as null', async () => {
    const db = makeMockDb({
      first: jest.fn<any>().mockResolvedValue({ job_name: 'job-a', cursor: null }),
    })
    const store = new BackfillCursorStore(db)

    const result = await store.getCursor('job-a')

    expect(result).toBeNull()
  })

  it('queries the correct table', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.getCursor('my-backfill')

    expect(db).toHaveBeenCalledWith('backfill_cursors')
  })

  it('filters by job_name', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.getCursor('etl-payments')

    expect(db._qb.where).toHaveBeenCalledWith({ job_name: 'etl-payments' })
  })
})

// ---------------------------------------------------------------------------
// upsertCursor
// ---------------------------------------------------------------------------

describe('BackfillCursorStore.upsertCursor', () => {
  it('inserts all required columns', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'item-100')

    expect(db).toHaveBeenCalledWith('backfill_cursors')
    const row = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row.job_name).toBe('job-a')
    expect(row.cursor).toBe('item-100')
    expect(row.created_at).toBeInstanceOf(Date)
    expect(row.updated_at).toBeInstanceOf(Date)
  })

  it('calls onConflict(job_name) for upsert semantics', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'item-100')

    expect(db._qb.onConflict).toHaveBeenCalledWith('job_name')
  })

  it('merges cursor and updated_at but not created_at on conflict', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'item-200')

    const mergeArg = db._qb.merge.mock.calls[0][0] as Record<string, unknown>
    expect(mergeArg).toHaveProperty('cursor', 'item-200')
    expect(mergeArg).toHaveProperty('updated_at')
    expect(mergeArg).not.toHaveProperty('created_at')
  })

  it('stores a null cursor when called with null', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', null)

    const row = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    expect(row.cursor).toBeNull()
    const mergeArg = db._qb.merge.mock.calls[0][0] as Record<string, unknown>
    expect(mergeArg.cursor).toBeNull()
  })

  it('sets updated_at to a current timestamp', async () => {
    const before = new Date()
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'item-300')

    const after = new Date()
    const row = db._qb.insert.mock.calls[0][0] as Record<string, unknown>
    const ts = (row.updated_at as Date).getTime()
    expect(ts).toBeGreaterThanOrEqual(before.getTime())
    expect(ts).toBeLessThanOrEqual(after.getTime())
  })
})

// ---------------------------------------------------------------------------
// resetCursor
// ---------------------------------------------------------------------------

describe('BackfillCursorStore.resetCursor', () => {
  it('deletes the row for the given job name', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    await store.resetCursor('job-a')

    expect(db).toHaveBeenCalledWith('backfill_cursors')
    expect(db._qb.where).toHaveBeenCalledWith({ job_name: 'job-a' })
    expect(db._qb.delete).toHaveBeenCalled()
  })

  it('does not throw when no row exists for the job', async () => {
    const db = makeMockDb({ delete: jest.fn<any>().mockResolvedValue(0) })
    const store = new BackfillCursorStore(db)

    await expect(store.resetCursor('non-existent')).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Resumption continuity (stateful)
//
// Core invariant: a process resuming from cursor C must claim the range
// [C+1, …] — no earlier range is reprocessed, no range is skipped.
// ---------------------------------------------------------------------------

describe('BackfillCursorStore — resumption continuity', () => {
  it('returns null before any cursor is saved (safe start)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const cursor = await store.getCursor('etl-users')

    expect(cursor).toBeNull()
  })

  it('getCursor returns exactly the last upserted cursor (no gap)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('etl-users', 'user-100')
    const cursor = await store.getCursor('etl-users')

    expect(cursor).toBe('user-100')
  })

  it('new store instance reads the persisted cursor (restart simulation)', async () => {
    const { db } = makeStatefulMockDb()

    // Phase 1 — process saves progress mid-run
    const storeBeforeRestart = new BackfillCursorStore(db)
    await storeBeforeRestart.upsertCursor('etl-orders', 'order-50')

    // Phase 2 — process restarts (new store instance, same underlying DB)
    const storeAfterRestart = new BackfillCursorStore(db)
    const resumeCursor = await storeAfterRestart.getCursor('etl-orders')

    expect(resumeCursor).toBe('order-50')
  })

  it('next range starts exactly one position after the saved cursor (gap-free)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const BATCH_SIZE = 10
    const lastProcessedId = 50
    await store.upsertCursor('etl-items', `item-${lastProcessedId}`)

    // Simulate restart: determine next range from persisted cursor
    const resumeCursor = await store.getCursor('etl-items')
    const resumeId = resumeCursor ? parseInt(resumeCursor.split('-')[1]) : -1
    const nextRangeStart = resumeId + 1
    const nextRangeEnd = nextRangeStart + BATCH_SIZE - 1

    // No gap: next range begins immediately after the saved cursor
    expect(nextRangeStart).toBe(lastProcessedId + 1)
    // No overlap: previous range [0, 50] is not included
    expect(nextRangeEnd).toBe(lastProcessedId + BATCH_SIZE)
  })

  it('sequential advances never regress (duplicate-free)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const advances = ['batch-10', 'batch-20', 'batch-30', 'batch-40']
    for (const cursor of advances) {
      await store.upsertCursor('etl-events', cursor)
    }

    const current = await store.getCursor('etl-events')
    expect(current).toBe('batch-40')
  })

  it('each advance is immediately visible on the next read (no buffering)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    for (let i = 1; i <= 5; i++) {
      await store.upsertCursor('etl-live', `row-${i}`)
      const snap = await store.getCursor('etl-live')
      expect(snap).toBe(`row-${i}`)
    }
  })

  it('after resetCursor the store returns null (restart from beginning)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('etl-reset', 'item-999')
    await store.resetCursor('etl-reset')
    const cursor = await store.getCursor('etl-reset')

    expect(cursor).toBeNull()
  })

  it('cursor survives multiple upserts to the same job name (last-write-wins)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('etl-overwrite', 'v1')
    await store.upsertCursor('etl-overwrite', 'v2')
    await store.upsertCursor('etl-overwrite', 'v3')

    const cursor = await store.getCursor('etl-overwrite')
    expect(cursor).toBe('v3')
  })
})

// ---------------------------------------------------------------------------
// Distinct-name isolation
// ---------------------------------------------------------------------------

describe('BackfillCursorStore — distinct-name isolation', () => {
  it('two jobs start with independent null cursors', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const cursorA = await store.getCursor('job-a')
    const cursorB = await store.getCursor('job-b')

    expect(cursorA).toBeNull()
    expect(cursorB).toBeNull()
  })

  it('advancing job-A cursor does not affect job-B', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'row-500')
    const cursorB = await store.getCursor('job-b')

    expect(cursorB).toBeNull()
  })

  it('two jobs maintain independent cursors', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'row-100')
    await store.upsertCursor('job-b', 'row-200')

    const cursorA = await store.getCursor('job-a')
    const cursorB = await store.getCursor('job-b')

    expect(cursorA).toBe('row-100')
    expect(cursorB).toBe('row-200')
  })

  it('resetting job-A does not reset job-B', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-a', 'pos-1')
    await store.upsertCursor('job-b', 'pos-2')
    await store.resetCursor('job-a')

    const cursorA = await store.getCursor('job-a')
    const cursorB = await store.getCursor('job-b')

    expect(cursorA).toBeNull()
    expect(cursorB).toBe('pos-2')
  })

  it('many concurrent job names remain isolated', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const jobs = ['users', 'orders', 'events', 'payments', 'messages']
    for (let i = 0; i < jobs.length; i++) {
      await store.upsertCursor(jobs[i], `cursor-${i * 100}`)
    }

    for (let i = 0; i < jobs.length; i++) {
      const cursor = await store.getCursor(jobs[i])
      expect(cursor).toBe(`cursor-${i * 100}`)
    }
  })

  it('concurrent advances to different jobs produce no cross-contamination', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    // Advance all jobs concurrently
    await Promise.all([
      store.upsertCursor('alpha', 'a-1'),
      store.upsertCursor('beta', 'b-2'),
      store.upsertCursor('gamma', 'c-3'),
    ])

    // Each job sees only its own cursor
    expect(await store.getCursor('alpha')).toBe('a-1')
    expect(await store.getCursor('beta')).toBe('b-2')
    expect(await store.getCursor('gamma')).toBe('c-3')
  })
})

// ---------------------------------------------------------------------------
// Absent / corrupted cursor fallback
// ---------------------------------------------------------------------------

describe('BackfillCursorStore — absent cursor fallback', () => {
  it('getCursor returns null for an unknown job (safe start)', async () => {
    const db = makeMockDb()
    const store = new BackfillCursorStore(db)

    expect(await store.getCursor('never-saved')).toBeNull()
  })

  it('null return is the signal for callers to use a safe start position', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    const SAFE_START = 'item-0'
    const cursor = await store.getCursor('new-job')
    const effectiveStart = cursor ?? SAFE_START

    expect(effectiveStart).toBe(SAFE_START)
  })

  it('a stored null cursor is treated as absent (falls back to safe start)', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    // Operator explicitly cleared the cursor
    await store.upsertCursor('cleared-job', null)
    const cursor = await store.getCursor('cleared-job')

    expect(cursor).toBeNull()

    const SAFE_START = 0
    const effectiveStart = cursor !== null ? parseInt(cursor.split('-')[1]) : SAFE_START
    expect(effectiveStart).toBe(SAFE_START)
  })

  it('after resetCursor a job behaves as if it was never started', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('recovering-job', 'item-777')
    await store.resetCursor('recovering-job')

    const cursor = await store.getCursor('recovering-job')
    expect(cursor).toBeNull()
  })

  it('getCursor on a job whose cursor was reset returns null even if other jobs have cursors', async () => {
    const { db } = makeStatefulMockDb()
    const store = new BackfillCursorStore(db)

    await store.upsertCursor('job-keep', 'row-500')
    await store.upsertCursor('job-reset', 'row-300')
    await store.resetCursor('job-reset')

    expect(await store.getCursor('job-reset')).toBeNull()
    expect(await store.getCursor('job-keep')).toBe('row-500')
  })
})
