import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import type { WebhookSubscriber } from '../services/webhooks.js'

const mockSubscribers: WebhookSubscriber[] = []

jest.unstable_mockModule('../db/knex.js', () => ({
  db: {} as any,
  closeDatabase: jest.fn(),
}))

jest.unstable_mockModule('../repositories/webhookSubscriberRepository.js', () => ({
  WebhookSubscriberRepository: jest.fn().mockImplementation(() => ({
    findByOrg: jest.fn(async (orgId: string) =>
      mockSubscribers.filter((s) => s.organizationId === orgId && s.active),
    ),
    findById: jest.fn(async (id: string) =>
      mockSubscribers.find((s) => s.id === id) ?? null,
    ),
    findByEvent: jest.fn(async (orgId: string, event: string) =>
      mockSubscribers.filter(
        (s) =>
          s.organizationId === orgId &&
          s.active &&
          (s.events.length === 0 || s.events.includes(event)),
      ),
    ),
    create: jest.fn(async (data: any) => {
      const sub: WebhookSubscriber = {
        id: randomUUID(),
        organizationId: data.organizationId,
        url: data.url,
        secret: data.secret,
        events: [...data.events],
        active: true,
        schemaVersion: data.schemaVersion ?? 1,
        createdAt: new Date().toISOString(),
      }
      mockSubscribers.push(sub)
      return sub
    }),
    remove: jest.fn(async (id: string): Promise<boolean> => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) {
        mockSubscribers.splice(idx, 1)
        return true
      }
      return false
    }),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => {}),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
  })),
}))

const {
  addSubscriber,
  dispatchWebhookEvent,
  KNOWN_EVENT_TYPES,
} = await import('../services/webhooks.js')

const TEST_ORG = 'test-org-id'

const makePayload = (eventType = 'vault_created') => ({
  eventId: randomUUID(),
  eventType,
  timestamp: new Date().toISOString(),
  data: { vaultId: randomUUID(), name: 'test-vault' },
  organizationId: TEST_ORG,
})

beforeEach(() => {
  mockSubscribers.length = 0
})

// ── Event type validation in addSubscriber ─────────────────────────────────────

describe('addSubscriber event type validation', () => {
  it('accepts empty events array (wildcard)', async () => {
    const sub = await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', [])
    expect(sub.events).toEqual([])
  })

  it('accepts known event types', async () => {
    for (const event of KNOWN_EVENT_TYPES) {
      const sub = await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', [event])
      expect(sub.events).toEqual([event])
    }
  })

  it('accepts multiple known event types', async () => {
    const sub = await addSubscriber(
      TEST_ORG, 'https://example.com/hook', 'secret',
      ['vault_created', 'vault_completed'],
    )
    expect(sub.events).toEqual(['vault_created', 'vault_completed'])
  })

  it('rejects unknown event types', async () => {
    await expect(
      addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_slashed']),
    ).rejects.toThrow('Unknown event type: "vault_slashed"')
  })

  it('rejects if any event type is unknown', async () => {
    await expect(
      addSubscriber(
        TEST_ORG, 'https://example.com/hook', 'secret',
        ['vault_created', 'vault_slashed'],
      ),
    ).rejects.toThrow('Unknown event type: "vault_slashed"')
  })
})

// ── Event type filter behaviour in dispatchWebhookEvent ────────────────────────

describe('dispatchWebhookEvent event type filtering', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>

  beforeEach(async () => {
    mockSubscribers.length = 0
    fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any
  })

  afterEach(() => {
    mockSubscribers.length = 0
    jest.restoreAllMocks()
  })

  it('delivers to subscriber with empty events (wildcard)', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
  })

  it('delivers when subscriber event type matches', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_completed'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_completed'))
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
  })

  it('skips delivery when subscriber event type does not match', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_completed'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))
    expect(results).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delivers only to matching subscribers among many', async () => {
    await addSubscriber(TEST_ORG, 'https://a.example.com/hook', 'secret', ['vault_created'])
    await addSubscriber(TEST_ORG, 'https://b.example.com/hook', 'secret', ['vault_completed'])
    await addSubscriber(TEST_ORG, 'https://c.example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))
    expect(results).toHaveLength(2)
    const urls = results.map((r) => r.url).sort()
    expect(urls).toEqual(['https://a.example.com/hook', 'https://c.example.com/hook'])
  })

  it('works with milestone and settlement event types', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['milestone_created'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('milestone_created'))
    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)
  })
})

// ── KNOWN_EVENT_TYPES ─────────────────────────────────────────────────────────

describe('KNOWN_EVENT_TYPES', () => {
  it('includes vault lifecycle events', () => {
    expect(KNOWN_EVENT_TYPES.has('vault_created')).toBe(true)
    expect(KNOWN_EVENT_TYPES.has('vault_completed')).toBe(true)
    expect(KNOWN_EVENT_TYPES.has('vault_failed')).toBe(true)
    expect(KNOWN_EVENT_TYPES.has('vault_cancelled')).toBe(true)
  })

  it('includes milestone events', () => {
    expect(KNOWN_EVENT_TYPES.has('milestone_created')).toBe(true)
    expect(KNOWN_EVENT_TYPES.has('milestone_validated')).toBe(true)
  })

  it('includes settlement summary', () => {
    expect(KNOWN_EVENT_TYPES.has('settlement_summary')).toBe(true)
  })
})
