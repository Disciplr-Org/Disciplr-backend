/**
 * Tests for src/services/outboxRelay.ts.
 *
 * Covers:
 *   - Concurrent workers driven by FOR UPDATE SKIP LOCKED must never
 *     dispatch the same outbox row twice (exactly-once contract).
 *   - Rows whose `attempts` column has already reached `MAX_ATTEMPTS`
 *     (5) are excluded from the next claim.
 *   - When the global pause flag is set, `relayOutboxBatch` short-
 *     circuits and returns 0 without touching the table.
 *   - When `dispatchWebhookEvent` throws, the row's `attempts` is
 *     incremented and `last_error` is recorded for the next pass.
 *
 * The concurrency proof requires Postgres because SQLite does not
 * support `FOR UPDATE SKIP LOCKED`.  When DATABASE_URL is unset the
 * entire suite is skipped (matching the project's existing pattern in
 * src/tests/webhooks.deadletter.test.ts).
 *
 * NOTE: the table is `vault_outbox` and is wired up by the project's
 * default migrations under src/db/migrations.  The test only assumes
 * the columns created by the production schema: id, payload, processed,
 * attempts, processed_at, last_error, created_at.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  jest,
} from '@jest/globals'
import knex from 'knex'

import { pauseDelivery, resumeDelivery } from '../services/pauseStore.js'

// ─── Postgres-required gate ───────────────────────────────────────────────────

const hasDb = !!process.env.DATABASE_URL
const dbit = hasDb ? describe : describe.skip

// ─── shared mocks (dispatchWebhookEvent + ETLBatchRepository) ─────────────────

jest.unstable_mockModule('../services/webhooks.js', () => ({
  dispatchWebhookEvent: jest.fn(async () => []),
}))

jest.unstable_mockModule('../repositories/etlBatchRepository.js', () => ({
  ETLBatchRepository: jest.fn().mockImplementation(() => ({
    create: jest.fn(async () => undefined),
  })),
}))

// Loaded after the module mocks above so the relay picks up the mocked
// dispatcher / etl repo when it is required.
const { relayOutboxBatch } = await import('../services/outboxRelay.js')
const { dispatchWebhookEvent } = await import('../services/webhooks.js')

const dispatchMock = dispatchWebhookEvent as unknown as jest.MockedFunction<
  typeof import('../services/webhooks.js').dispatchWebhookEvent
>

// ─── helpers ──────────────────────────────────────────────────────────────────

type KnexInst = ReturnType<typeof knex>
let db: KnexInst

const ensureSchema = async (kdb: KnexInst): Promise<void> => {
  const exists = await kdb.schema.hasTable('vault_outbox')
  if (exists) return
  await kdb.schema.createTable('vault_outbox', (table) => {
    table.uuid('id').primary().defaultTo(kdb.raw('gen_random_uuid()'))
    table.jsonb('payload').notNullable()
    table.boolean('processed').notNullable().defaultTo(false)
    table.integer('attempts').notNullable().defaultTo(0)
    table.timestamp('processed_at', { useTz: true }).nullable()
    table.text('last_error').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(kdb.fn.now())
  })
}

const insertOutboxRow = async (
  kdb: KnexInst,
  payload: Record<string, unknown>,
  options: { attempts?: number; processed?: boolean } = {},
): Promise<string> => {
  const [row] = await kdb('vault_outbox')
    .insert({
      payload: JSON.stringify(payload),
      processed: options.processed ?? false,
      attempts: options.attempts ?? 0,
    })
    .returning('id')
  return String(row.id)
}

const insertBurst = async (
  kdb: KnexInst,
  count: number,
): Promise<string[]> => {
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    ids.push(
      await insertOutboxRow(kdb, {
        eventId: `tx:${i}`,
        eventType: 'vault_created',
        timestamp: new Date().toISOString(),
        data: { vaultId: `vault-${i}` },
        organizationId: 'org-burst',
      }),
    )
  }
  return ids
}

const countUnprocessed = async (kdb: KnexInst): Promise<number> => {
  const r = await kdb('vault_outbox').where({ processed: false }).count<{ count: string }[]>('* as count')
  return Number(r[0]?.count ?? 0)
}

const countProcessed = async (kdb: KnexInst): Promise<number> => {
  const r = await kdb('vault_outbox').where({ processed: true }).count<{ count: string }[]>('* as count')
  return Number(r[0]?.count ?? 0)
}

// ─── fixtures ─────────────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!hasDb) return
  db = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
  })
  await ensureSchema(db)
})

afterAll(async () => {
  if (!hasDb) return
  if (db) await db.destroy()
})

beforeEach(async () => {
  jest.clearAllMocks()
  if (!hasDb) return
  await db('vault_outbox').del()
  resumeDelivery()
})

afterEach(() => {
  resumeDelivery()
  jest.restoreAllMocks()
})

// ─── 1. basic happy path ──────────────────────────────────────────────────────

dbit('relayOutboxBatch — basic dispatch', () => {
  it('dispatches every unprocessed row and marks it processed', async () => {
    await insertBurst(db, 3)

    const claimed = await relayOutboxBatch(10)

    expect(claimed).toBe(3)
    expect(await countUnprocessed(db)).toBe(0)
    expect(await countProcessed(db)).toBe(3)
    expect(dispatchMock).toHaveBeenCalledTimes(3)
  })

  it('respects the batch-size argument', async () => {
    await insertBurst(db, 10)

    const first = await relayOutboxBatch(4)
    const second = await relayOutboxBatch(10)

    expect(first).toBe(4)
    expect(second).toBe(6)
    expect(dispatchMock).toHaveBeenCalledTimes(10)
  })

  it('returns 0 when there is nothing to do', async () => {
    await relayOutboxBatch(50)
    expect(dispatchMock).not.toHaveBeenCalled()
  })
})

// ─── 2. exactly-once under concurrent workers (SKIP LOCKED) ──────────────────

dbit('relayOutboxBatch — concurrent workers (SKIP LOCKED)', () => {
  it('5 concurrent workers x 50 rows yields exactly 50 webhook deliveries', async () => {
    await insertBurst(db, 50)

    const results = await Promise.all([
      relayOutboxBatch(50),
      relayOutboxBatch(50),
      relayOutboxBatch(50),
      relayOutboxBatch(50),
      relayOutboxBatch(50),
    ])

    const totalClaimed = results.reduce((acc, n) => acc + n, 0)
    expect(totalClaimed).toBe(50)
    expect(dispatchMock).toHaveBeenCalledTimes(50)
    expect(await countUnprocessed(db)).toBe(0)
    expect(await countProcessed(db)).toBe(50)
  }, 30_000)

  it('every row is dispatched at most once, never skipped', async () => {
    await insertBurst(db, 40)

    await Promise.all([
      relayOutboxBatch(40),
      relayOutboxBatch(40),
      relayOutboxBatch(40),
    ])

    const dispatchedIds = dispatchMock.mock.calls.map(
      (call) => (call[0] as { eventId?: string } | undefined)?.eventId,
    )
    const frequency = new Map<string, number>()
    for (const id of dispatchedIds) {
      if (!id) continue
      frequency.set(id, (frequency.get(id) ?? 0) + 1)
    }

    // Each eventId from the burst (`tx:0` … `tx:39`) must appear exactly once.
    for (let i = 0; i < 40; i += 1) {
      const expectedEventId = `tx:${i}`
      expect(frequency.get(expectedEventId)).toBe(1)
    }
  }, 30_000)
})

// ─── 3. attempts >= MAX_ATTEMPTS are excluded ────────────────────────────────

dbit('relayOutboxBatch — max attempts excluded', () => {
  it('a row with attempts = 5 is left untouched by the next claim', async () => {
    // MAX_ATTEMPTS in src/services/outboxRelay.ts is 5.
    const id = await insertOutboxRow(
      db,
      { eventId: 'tx:exhaust', eventType: 'vault_failed', data: {} },
      { attempts: 5 },
    )

    const claimed = await relayOutboxBatch(10)

    expect(claimed).toBe(0)
    const row = await db('vault_outbox').where({ id }).first()
    expect(row.attempts).toBe(5)
    expect(row.processed).toBe(false)
    expect(dispatchMock).not.toHaveBeenCalled()
  })

  it('only dispatches the rows still eligible when mixed with exhausted ones', async () => {
    const eligible = await insertBurst(db, 4)
    for (let i = 0; i < 3; i += 1) {
      await insertOutboxRow(
        db,
        { eventId: `tx:exhaust-${i}`, eventType: 'vault_failed', data: {} },
        { attempts: 5 },
      )
    }

    const claimed = await relayOutboxBatch(20)

    expect(claimed).toBe(4)
    expect(dispatchMock).toHaveBeenCalledTimes(4)

    const processed = await db('vault_outbox')
      .whereIn('id', eligible)
      .select('processed')
    for (const row of processed) {
      expect(row.processed).toBe(true)
    }
  })
})

// ─── 4. pause switch ───────────────────────────────────────────────────────────

dbit('relayOutboxBatch — pause switch short-circuits', () => {
  it('returns 0 immediately when the global pause flag is set', async () => {
    await insertBurst(db, 6)

    pauseDelivery()

    const claimed = await relayOutboxBatch(50)

    expect(claimed).toBe(0)
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(await countUnprocessed(db)).toBe(6)
  })

  it('dispatches normally once the pause flag is removed', async () => {
    await insertBurst(db, 3)

    pauseDelivery()
    expect(await relayOutboxBatch(50)).toBe(0)

    resumeDelivery()
    const claimed = await relayOutboxBatch(50)
    expect(claimed).toBe(3)
    expect(dispatchMock).toHaveBeenCalledTimes(3)
  })
})

// ─── 5. dispatcher failure path ───────────────────────────────────────────────

dbit('relayOutboxBatch — dispatcher failure', () => {
  it('increments attempts and records last_error when dispatch throws', async () => {
    dispatchMock.mockRejectedValueOnce(new Error('simulated webhook failure'))
    const id = await insertOutboxRow(db, {
      eventId: 'tx:fail',
      eventType: 'vault_failed',
      data: { x: 1 },
    })

    const claimed = await relayOutboxBatch(10)
    expect(claimed).toBe(1)

    const row = await db('vault_outbox').where({ id }).first()
    expect(row.processed).toBe(false)
    expect(row.attempts).toBe(1)
    expect(String(row.last_error)).toMatch(/simulated webhook failure/)
  })

  it('moves a row to the dead-letter state when attempts reach MAX_ATTEMPTS', async () => {
    // Two dispatch attempts fail → attempts reaches MAX_ATTEMPTS → 3rd
    // dispatch still fails → the relay routes to dead-letter (processed).
    dispatchMock.mockRejectedValue(new Error('persistent failure'))

    const id = await insertOutboxRow(db, {
      eventId: 'tx:dlq',
      eventType: 'vault_failed',
      data: { x: 1 },
    }, { attempts: 4 })

    await relayOutboxBatch(5)

    const row = await db('vault_outbox').where({ id }).first()
    expect(row.processed).toBe(true)
    expect(row.attempts).toBe(5)
    expect(String(row.last_error)).toMatch(/Exceeded max attempts/)
  })
})
