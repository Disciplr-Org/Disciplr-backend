import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomUUID } from 'node:crypto'
import type { WebhookSubscriber } from '../services/webhooks.js'
import {
  applyFieldMasking,
  isValidFieldPolicy,
  parseFieldPolicy,
  DEFAULT_FIELD_POLICY,
  FieldPolicy,
} from '../utils/webhookFieldMasking.js'

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
        (s) => s.organizationId === orgId && (s.events.length === 0 || s.events.includes(event)) && s.active,
      ),
    ),
    create: jest.fn(async (data: any) => {
      const sub: WebhookSubscriber = {
        id: randomUUID(),
        organizationId: data.organizationId,
        url: data.url,
        secret: data.secret,
        previousSecret: null,
        rotatedAt: null,
        events: [...data.events],
        active: true,
        schemaVersion: data.schemaVersion ?? 1,
        fieldPolicy: data.fieldPolicy ?? DEFAULT_FIELD_POLICY,
        createdAt: new Date().toISOString(),
      }
      mockSubscribers.push(sub)
      return sub
    }),
    remove: jest.fn(async (id: string) => {
      const idx = mockSubscribers.findIndex((s) => s.id === id)
      if (idx !== -1) mockSubscribers.splice(idx, 1)
    }),
    getBreakerState: jest.fn(async () => null),
    upsertBreakerState: jest.fn(async () => {}),
    tryTransitionToHalfOpen: jest.fn(async () => false),
    removeBreakerState: jest.fn(async () => true),
    getAllBreakerStates: jest.fn(async () => []),
    updateFieldPolicy: jest.fn(async (id: string, orgId: string, fieldPolicy: FieldPolicy) => {
      const sub = mockSubscribers.find((s) => s.id === id && s.organizationId === orgId)
      if (!sub) return null
      sub.fieldPolicy = fieldPolicy
      return sub
    }),
  })),
}))

const { buildVersionedPayload, dispatchWebhookEvent } = await import('../services/webhooks.js')

const TEST_ORG = 'test-org-id'

const makePayload = (overrides: Record<string, any> = {}) => ({
  eventId: randomUUID(),
  eventType: 'vault_created',
  timestamp: new Date().toISOString(),
  data: {
    vaultId: randomUUID(),
    name: 'test-vault',
    creator: 'user123',
    userId: 'user-abc',
    email: 'user@example.com',
    amount: 1000,
    nested: {
      sensitiveField: 'secret-value',
      normalField: 'visible-value',
    },
  },
  organizationId: TEST_ORG,
  ...overrides,
})

const makeSubscriber = (overrides: Record<string, any> = {}): WebhookSubscriber => ({
  id: randomUUID(),
  organizationId: TEST_ORG,
  url: 'https://hooks.example.com/webhook',
  secret: 'test-secret',
  previousSecret: null,
  rotatedAt: null,
  events: ['vault_created'],
  active: true,
  schemaVersion: 1,
  fieldPolicy: DEFAULT_FIELD_POLICY,
  createdAt: new Date().toISOString(),
  ...overrides,
})

beforeEach(() => {
  mockSubscribers.length = 0
})

// ── isValidFieldPolicy ─────────────────────────────────────────────────────────

describe('isValidFieldPolicy', () => {
  it('returns true for valid default policy', () => {
    expect(isValidFieldPolicy({ mode: 'default', fields: [], stripPii: true })).toBe(true)
  })

  it('returns true for valid allowlist policy', () => {
    expect(isValidFieldPolicy({ mode: 'allowlist', fields: ['id', 'name'], stripPii: true })).toBe(true)
  })

  it('returns true for valid denylist policy', () => {
    expect(isValidFieldPolicy({ mode: 'denylist', fields: ['secret'], stripPii: false })).toBe(true)
  })

  it('returns false for null', () => {
    expect(isValidFieldPolicy(null)).toBe(false)
  })

  it('returns false for invalid mode', () => {
    expect(isValidFieldPolicy({ mode: 'invalid', fields: [], stripPii: true })).toBe(false)
  })

  it('returns false for non-array fields', () => {
    expect(isValidFieldPolicy({ mode: 'default', fields: 'id', stripPii: true })).toBe(false)
  })

  it('returns false for non-boolean stripPii', () => {
    expect(isValidFieldPolicy({ mode: 'default', fields: [], stripPii: 'yes' })).toBe(false)
  })
})

// ── parseFieldPolicy ───────────────────────────────────────────────────────────

describe('parseFieldPolicy', () => {
  it('returns valid policy as-is', () => {
    const policy = { mode: 'allowlist' as const, fields: ['id'], stripPii: true }
    expect(parseFieldPolicy(policy)).toEqual(policy)
  })

  it('returns default policy for null', () => {
    expect(parseFieldPolicy(null)).toEqual(DEFAULT_FIELD_POLICY)
  })

  it('returns default policy for invalid input', () => {
    expect(parseFieldPolicy({ mode: 'invalid' })).toEqual(DEFAULT_FIELD_POLICY)
  })
})

// ── applyFieldMasking ──────────────────────────────────────────────────────────

describe('applyFieldMasking', () => {
  describe('default mode', () => {
    it('passes through all fields when stripPii is false', () => {
      const data = { id: '123', name: 'Test', creator: 'user1' }
      const result = applyFieldMasking(data, { mode: 'default', fields: [], stripPii: false })
      expect(result).toEqual(data)
    })

    it('masks PII fields when stripPii is true', () => {
      const data = { id: '123', name: 'Test', creator: 'user1', email: 'test@example.com' }
      const result = applyFieldMasking(data, { mode: 'default', fields: [], stripPii: true })
      expect(result.id).toBe('123')
      expect(result.name).toBe('Test')
      expect(result.creator).not.toBe('user1')
      expect(result.email).not.toBe('test@example.com')
      // Verify it's masked (should be 8-char hex)
      expect(typeof result.creator).toBe('string')
      expect((result.creator as string).length).toBe(8)
    })
  })

  describe('allowlist mode', () => {
    it('only includes specified fields', () => {
      const data = { id: '123', name: 'Test', secret: 'hidden' }
      const result = applyFieldMasking(data, { mode: 'allowlist', fields: ['id', 'name'], stripPii: false })
      expect(result).toEqual({ id: '123', name: 'Test' })
    })

    it('supports nested field paths', () => {
      const data = { id: '123', nested: { allowed: 'yes', denied: 'no' } }
      const result = applyFieldMasking(data, {
        mode: 'allowlist',
        fields: ['id', 'nested.allowed'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', nested: { allowed: 'yes' } })
    })

    it('supports wildcard patterns', () => {
      const data = { id: '123', vault: { name: 'Test', status: 'active' }, other: 'excluded' }
      const result = applyFieldMasking(data, {
        mode: 'allowlist',
        fields: ['id', 'vault.*'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', vault: { name: 'Test', status: 'active' } })
    })

    it('still applies PII masking when stripPii is true', () => {
      const data = { id: '123', creator: 'user1' }
      const result = applyFieldMasking(data, {
        mode: 'allowlist',
        fields: ['id', 'creator'],
        stripPii: true,
      })
      expect(result.id).toBe('123')
      expect(result.creator).not.toBe('user1')
    })
  })

  describe('denylist mode', () => {
    it('excludes specified fields', () => {
      const data = { id: '123', name: 'Test', secret: 'hidden' }
      const result = applyFieldMasking(data, { mode: 'denylist', fields: ['secret'], stripPii: false })
      expect(result).toEqual({ id: '123', name: 'Test' })
    })

    it('supports nested field paths', () => {
      const data = { id: '123', nested: { public: 'yes', private: 'no' } }
      const result = applyFieldMasking(data, {
        mode: 'denylist',
        fields: ['nested.private'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', nested: { public: 'yes' } })
    })

    it('supports wildcard patterns', () => {
      const data = { id: '123', internal: { a: '1', b: '2' }, public: 'visible' }
      const result = applyFieldMasking(data, {
        mode: 'denylist',
        fields: ['internal.*'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', public: 'visible' })
    })
  })
})

// ── buildVersionedPayload with field masking ───────────────────────────────────

describe('buildVersionedPayload with field masking', () => {
  const payload = makePayload()

  it('applies default PII stripping by default', () => {
    const subscriber = makeSubscriber({ fieldPolicy: DEFAULT_FIELD_POLICY })
    const json = JSON.parse(buildVersionedPayload(subscriber, payload))

    // PII fields should be masked
    expect(json.data.creator).not.toBe(payload.data.creator)
    expect(json.data.userId).not.toBe(payload.data.userId)
    expect(json.data.email).not.toBe(payload.data.email)

    // Non-PII fields should be preserved
    expect(json.data.vaultId).toBe(payload.data.vaultId)
    expect(json.data.name).toBe(payload.data.name)
    expect(json.data.amount).toBe(payload.data.amount)
  })

  it('respects stripPii: false in field policy', () => {
    const subscriber = makeSubscriber({
      fieldPolicy: { mode: 'default', fields: [], stripPii: false },
    })
    const json = JSON.parse(buildVersionedPayload(subscriber, payload))

    // All fields should be preserved including PII
    expect(json.data.creator).toBe(payload.data.creator)
    expect(json.data.userId).toBe(payload.data.userId)
    expect(json.data.email).toBe(payload.data.email)
  })

  it('applies allowlist filtering', () => {
    const subscriber = makeSubscriber({
      fieldPolicy: { mode: 'allowlist', fields: ['vaultId', 'name', 'amount'], stripPii: false },
    })
    const json = JSON.parse(buildVersionedPayload(subscriber, payload))

    expect(json.data.vaultId).toBe(payload.data.vaultId)
    expect(json.data.name).toBe(payload.data.name)
    expect(json.data.amount).toBe(payload.data.amount)
    expect(json.data.creator).toBeUndefined()
    expect(json.data.userId).toBeUndefined()
    expect(json.data.email).toBeUndefined()
  })

  it('applies denylist filtering', () => {
    const subscriber = makeSubscriber({
      fieldPolicy: { mode: 'denylist', fields: ['creator', 'userId', 'email'], stripPii: false },
    })
    const json = JSON.parse(buildVersionedPayload(subscriber, payload))

    expect(json.data.vaultId).toBe(payload.data.vaultId)
    expect(json.data.name).toBe(payload.data.name)
    expect(json.data.amount).toBe(payload.data.amount)
    expect(json.data.creator).toBeUndefined()
    expect(json.data.userId).toBeUndefined()
    expect(json.data.email).toBeUndefined()
  })

  it('signature is computed on masked payload', () => {
    const subscriber1 = makeSubscriber({
      fieldPolicy: { mode: 'default', fields: [], stripPii: true },
    })
    const subscriber2 = makeSubscriber({
      fieldPolicy: { mode: 'default', fields: [], stripPii: false },
    })

    const body1 = buildVersionedPayload(subscriber1, payload)
    const body2 = buildVersionedPayload(subscriber2, payload)

    // Bodies should be different due to masking
    expect(body1).not.toBe(body2)
  })
})

// ── dispatchWebhookEvent with field masking ────────────────────────────────────

describe('dispatchWebhookEvent with field masking', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    mockSubscribers.length = 0
    fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any
  })

  afterEach(() => {
    mockSubscribers.length = 0
    jest.restoreAllMocks()
  })

  it('delivers masked payload to subscriber with PII stripping', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    mockSubscribers.push(makeSubscriber({
      fieldPolicy: { mode: 'default', fields: [], stripPii: true },
    }))

    const payload = makePayload()
    await dispatchWebhookEvent(payload)

    const call = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string)

    // PII should be masked
    expect(body.data.creator).not.toBe(payload.data.creator)
  })

  it('delivers unmasked payload when stripPii is false', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    mockSubscribers.push(makeSubscriber({
      fieldPolicy: { mode: 'default', fields: [], stripPii: false },
    }))

    const payload = makePayload()
    await dispatchWebhookEvent(payload)

    const call = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(call[1].body as string)

    expect(body.data.creator).toBe(payload.data.creator)
    expect(body.data.email).toBe(payload.data.email)
  })

  it('different subscribers receive differently masked payloads', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    mockSubscribers.push(makeSubscriber({
      url: 'https://hooks.example.com/masked',
      fieldPolicy: { mode: 'default', fields: [], stripPii: true },
    }))
    mockSubscribers.push(makeSubscriber({
      url: 'https://hooks.example.com/unmasked',
      fieldPolicy: { mode: 'default', fields: [], stripPii: false },
    }))

    const payload = makePayload()
    await dispatchWebhookEvent(payload)

    const calls = (global.fetch as jest.Mock).mock.calls as [string, RequestInit][]
    const maskedCall = calls.find(([url]) => url === 'https://hooks.example.com/masked')!
    const unmaskedCall = calls.find(([url]) => url === 'https://hooks.example.com/unmasked')!

    const maskedBody = JSON.parse(maskedCall[1].body as string)
    const unmaskedBody = JSON.parse(unmaskedCall[1].body as string)

    expect(maskedBody.data.creator).not.toBe(payload.data.creator)
    expect(unmaskedBody.data.creator).toBe(payload.data.creator)
  })
})
