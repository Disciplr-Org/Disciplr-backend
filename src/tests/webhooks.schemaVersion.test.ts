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
      mockSubscribers.filter((s) => s.organizationId === orgId),
    ),
    findById: jest.fn(async (id: string) =>
      mockSubscribers.find((s) => s.id === id) ?? null,
    ),
    findByEvent: jest.fn(async (orgId: string, event: string) =>
      mockSubscribers.filter(
        (s) => s.organizationId === orgId && s.events.includes(event) && s.active,
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
    remove: jest.fn(async (id: string) => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) mockSubscribers.splice(idx, 1)
    }),
    update: jest.fn(async (id: string, data: any) => {
      const sub = mockSubscribers.find((s) => s.id === id)
      if (!sub) return null
      Object.assign(sub, data)
      return sub
    }),
    markInactive: jest.fn(async (id: string) => {
      const sub = mockSubscribers.find((s) => s.id === id)
      if (sub) sub.active = false
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
  buildVersionedPayload,
  dispatchWebhookEvent,
  LATEST_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
} = await import('../services/webhooks.js')

const TEST_ORG = 'test-org-id'

const makePayload = (overrides: Record<string, any> = {}) => ({
  eventId: randomUUID(),
  eventType: 'vault_created',
  timestamp: new Date().toISOString(),
  data: { vaultId: randomUUID(), name: 'test-vault' },
  organizationId: TEST_ORG,
  ...overrides,
})

const makeSubscriber = (overrides: Record<string, any> = {}) => ({
  id: randomUUID(),
  organizationId: TEST_ORG,
  url: 'https://hooks.example.com/webhook',
  secret: 'test-secret',
  events: ['vault_created'],
  active: true,
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  ...overrides,
})

beforeEach(() => {
  mockSubscribers.length = 0
})

// ── buildVersionedPayload ─────────────────────────────────────────────────────

describe('buildVersionedPayload', () => {
  const payload = makePayload({ eventType: 'vault_updated' })

  it('v1 includes all original fields plus schema_version', () => {
    const json = JSON.parse(buildVersionedPayload(makeSubscriber({ schemaVersion: 1 }), payload))
    expect(json.eventId).toBe(payload.eventId)
    expect(json.eventType).toBe(payload.eventType)
    expect(json.timestamp).toBe(payload.timestamp)
    expect(json.data).toEqual(payload.data)
    expect(json.organizationId).toBe(payload.organizationId)
    expect(json.schema_version).toBe(1)
  })

  it('v2 returns compact envelope', () => {
    const json = JSON.parse(buildVersionedPayload(makeSubscriber({ schemaVersion: 2 }), payload))
    expect(json.schema_version).toBe(2)
    expect(json.event_type).toBe(payload.eventType)
    expect(json.data).toEqual(payload.data)
    expect(json.eventId).toBeUndefined()
    expect(json.timestamp).toBeUndefined()
    expect(json.organizationId).toBeUndefined()
  })

  it('throws for unknown schema version', () => {
    const sub = makeSubscriber({ schemaVersion: 99 })
    expect(() => buildVersionedPayload(sub, payload)).toThrow('Unsupported webhook schema version: 99')
  })
})

// ── addSubscriber ─────────────────────────────────────────────────────────────

describe('addSubscriber schemaVersion', () => {
  beforeEach(() => {
    mockSubscribers.length = 0
  })

  it('defaults to schema version 1', async () => {
    const sub = await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_created'])
    expect(sub.schemaVersion).toBe(1)
  })

  it('accepts version 2', async () => {
    const sub = await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_created'], 2)
    expect(sub.schemaVersion).toBe(2)
  })

  it('rejects unsupported version', async () => {
    await expect(
      addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_created'], 99),
    ).rejects.toThrow('Unsupported webhook schema version: 99')
  })
})

// ── dispatchWebhookEvent integration ──────────────────────────────────────────

describe('dispatchWebhookEvent schema versioning', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    mockSubscribers.length = 0
    fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any

    mockSubscribers.push(makeSubscriber({
      url: 'https://hooks.example.com/v1',
      events: ['vault_created'],
      schemaVersion: 1,
    }))
    mockSubscribers.push(makeSubscriber({
      url: 'https://hooks.example.com/v2',
      events: ['vault_created'],
      schemaVersion: 2,
    }))
  })

  afterEach(() => {
    mockSubscribers.length = 0
    jest.restoreAllMocks()
  })

  it('delivers v1 envelope to version-1 subscribers', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const payload = makePayload()
    const results = await dispatchWebhookEvent(payload)

    const v1Result = results.find((r) => r.url === 'https://hooks.example.com/v1')
    expect(v1Result).toBeDefined()
    expect(v1Result!.success).toBe(true)

    const callArgs = (global.fetch as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === 'https://hooks.example.com/v1',
    )
    expect(callArgs).toBeDefined()
    const body = JSON.parse(callArgs[1].body)
    expect(body.schema_version).toBe(1)
    expect(body.eventId).toBe(payload.eventId)
    expect(body.data).toEqual(payload.data)
  })

  it('delivers v2 envelope to version-2 subscribers', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const payload = makePayload()
    const results = await dispatchWebhookEvent(payload)

    const v2Result = results.find((r) => r.url === 'https://hooks.example.com/v2')
    expect(v2Result).toBeDefined()
    expect(v2Result!.success).toBe(true)

    const callArgs = (global.fetch as jest.Mock).mock.calls.find(
      (c: any[]) => c[0] === 'https://hooks.example.com/v2',
    )
    expect(callArgs).toBeDefined()
    const body = JSON.parse(callArgs[1].body)
    expect(body.schema_version).toBe(2)
    expect(body.event_type).toBe(payload.eventType)
    expect(body.data).toEqual(payload.data)
    expect(body.eventId).toBeUndefined()
  })

  it('signature differs per schema version', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const payload = makePayload()
    await dispatchWebhookEvent(payload)

    const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][]
    const v1Call = calls.find(([url]) => url === 'https://hooks.example.com/v1')!
    const v2Call = calls.find(([url]) => url === 'https://hooks.example.com/v2')!
    expect(v1Call).toBeDefined()
    expect(v2Call).toBeDefined()

    const v1Sig = (v1Call[1].headers as Record<string, string>)['x-disciplr-signature']
    const v2Sig = (v2Call[1].headers as Record<string, string>)['x-disciplr-signature']
    expect(v1Sig).not.toBe(v2Sig)
  })
})

// ── Constants ─────────────────────────────────────────────────────────────────

describe('schema version constants', () => {
  it('LATEST_SCHEMA_VERSION is 2', () => {
    expect(LATEST_SCHEMA_VERSION).toBe(2)
  })

  it('SUPPORTED_SCHEMA_VERSIONS includes 1 and 2', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toEqual(new Set([1, 2]))
  })
})
