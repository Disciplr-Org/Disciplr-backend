import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import {
  addSubscriber,
  resetSubscribers,
  dispatchWebhookEvent,
  replayDeadLetter,
} from '../services/webhooks.js'

// Skip entire suite when no database is available
const hasDb = !!process.env.DATABASE_URL

const describeDb = hasDb ? describe : describe.skip

describeDb('webhook dead-letter queue', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>

  beforeEach(async () => {
    resetSubscribers()
    fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any
    const { db } = await import('../db/index.js')
    await db('webhook_dead_letters').del()
  })

  afterEach(() => {
    resetSubscribers()
    jest.restoreAllMocks()
  })

  const makePayload = (overrides?: Record<string, unknown>) => ({
    eventId: 'deadbeef:0',
    eventType: 'vault_created',
    timestamp: new Date().toISOString(),
    data: { vaultId: 'vault-1' },
    ...overrides,
  })

  it('persists a dead letter when delivery exhausts retries', async () => {
    addSubscriber('https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 503 } as Response)

    await dispatchWebhookEvent(makePayload())

    const { db } = await import('../db/index.js')
    const rows = await db('webhook_dead_letters').select('*')
    expect(rows).toHaveLength(1)
    expect(rows[0].subscriber_id).toBeTruthy()
    expect(rows[0].event_id).toBe('deadbeef:0')
    expect(rows[0].last_error).toMatch(/HTTP 503/)
    expect(rows[0].attempts).toBeGreaterThan(0)
    expect(rows[0].replayed_at).toBeNull()
  }, 20_000)

  it('does not persist a dead letter on successful delivery', async () => {
    addSubscriber('https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    await dispatchWebhookEvent(makePayload())

    const { db } = await import('../db/index.js')
    const rows = await db('webhook_dead_letters').select('*')
    expect(rows).toHaveLength(0)
  })

  it('replayDeadLetter returns error for missing id', async () => {
    const result = await replayDeadLetter('00000000-0000-0000-0000-000000000000')
    expect(result.replayed).toBe(false)
    expect(result.error).toMatch(/not found/)
  })

  it('replayDeadLetter returns error when subscriber not registered', async () => {
    const { db } = await import('../db/index.js')
    const [row] = await db('webhook_dead_letters')
      .insert({
        subscriber_id: 'unregistered-sub',
        event_id: 'test:0',
        event_type: 'vault_created',
        payload: makePayload(),
        last_error: 'test error',
        attempts: 3,
      })
      .returning('id')

    const result = await replayDeadLetter(row.id)
    expect(result.replayed).toBe(false)
    expect(result.error).toMatch(/not registered/)
  })

  it('replayDeadLetter re-delivers and stamps replayed_at', async () => {
    const sub = addSubscriber('https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const { db } = await import('../db/index.js')
    const [row] = await db('webhook_dead_letters')
      .insert({
        subscriber_id: sub.id,
        event_id: 'replay:0',
        event_type: 'vault_created',
        payload: makePayload({ eventId: 'replay:0' }),
        last_error: 'test error',
        attempts: 3,
      })
      .returning('id')

    const result = await replayDeadLetter(row.id)
    expect(result.replayed).toBe(true)

    const updated = await db('webhook_dead_letters').where({ id: row.id }).first()
    expect(updated.replayed_at).not.toBeNull()
  })

  it('replayDeadLetter fails gracefully when delivery fails', async () => {
    const sub = addSubscriber('https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 500 } as Response)

    const { db } = await import('../db/index.js')
    const [row] = await db('webhook_dead_letters')
      .insert({
        subscriber_id: sub.id,
        event_id: 'fail-replay:0',
        event_type: 'vault_created',
        payload: makePayload({ eventId: 'fail-replay:0' }),
        last_error: 'original error',
        attempts: 3,
      })
      .returning('id')

    const result = await replayDeadLetter(row.id)
    expect(result.replayed).toBe(false)
    expect(result.error).toMatch(/HTTP 500/)

    const updated = await db('webhook_dead_letters').where({ id: row.id }).first()
    expect(updated.replayed_at).toBeNull()
  }, 20_000)

  it('replayDeadLetter rejects already-replayed entries', async () => {
    const sub = addSubscriber('https://example.com/hook', 'secret', [])

    const { db } = await import('../db/index.js')
    const [row] = await db('webhook_dead_letters')
      .insert({
        subscriber_id: sub.id,
        event_id: 'already:0',
        event_type: 'vault_created',
        payload: makePayload({ eventId: 'already:0' }),
        last_error: 'error',
        attempts: 3,
        replayed_at: new Date().toISOString(),
      })
      .returning('id')

    const result = await replayDeadLetter(row.id)
    expect(result.replayed).toBe(false)
    expect(result.error).toMatch(/already replayed/)
  })
})
