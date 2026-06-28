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
    findByEvent: jest.fn(async (orgId: string, eventType: string) =>
      mockSubscribers.filter(
        (s) =>
          s.organizationId === orgId &&
          s.active &&
          (s.events.length === 0 || s.events.includes(eventType)),
      ),
    ),
    create: jest.fn(
      async (data: {
        organizationId: string
        url: string
        secret: string
        events: string[]
        schemaVersion?: number
      }): Promise<WebhookSubscriber> => {
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
          createdAt: new Date().toISOString(),
        }
        mockSubscribers.push(sub)
        return sub
      },
    ),
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
  signPayload,
  verifySignature,
  isUrlAllowed,
  addSubscriber,
  removeSubscriber,
  listSubscribers,
  dispatchWebhookEvent,
  VAULT_LIFECYCLE_EVENTS,
} = await import('../services/webhooks.js')

const TEST_ORG = 'test-org-id'

// ─── HMAC signature ───────────────────────────────────────────────────────────

describe('signPayload', () => {
  it('returns a sha256= prefixed hex string', () => {
    const sig = signPayload('secret', '{"hello":"world"}')
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  it('produces a deterministic signature for the same inputs', () => {
    const body = '{"eventType":"vault_created"}'
    expect(signPayload('s3cr3t', body)).toBe(signPayload('s3cr3t', body))
  })

  it('produces different signatures for different secrets', () => {
    const body = '{"eventType":"vault_created"}'
    expect(signPayload('secret-a', body)).not.toBe(signPayload('secret-b', body))
  })

  it('produces different signatures for different bodies', () => {
    expect(signPayload('secret', 'body-a')).not.toBe(signPayload('secret', 'body-b'))
  })
})

describe('verifySignature', () => {
  it('returns true for a correct signature', () => {
    const body = '{"hello":"world"}'
    const sig = signPayload('my-secret', body)
    expect(verifySignature('my-secret', body, sig)).toBe(true)
  })

  it('returns false for a tampered body', () => {
    const sig = signPayload('my-secret', 'original-body')
    expect(verifySignature('my-secret', 'tampered-body', sig)).toBe(false)
  })

  it('returns false for a wrong secret', () => {
    const body = '{"hello":"world"}'
    const sig = signPayload('correct-secret', body)
    expect(verifySignature('wrong-secret', body, sig)).toBe(false)
  })

  it('returns false for a length-mismatched signature', () => {
    expect(verifySignature('secret', 'body', 'sha256=tooshort')).toBe(false)
  })
})

// ─── SSRF / URL allowlist ─────────────────────────────────────────────────────

describe('isUrlAllowed', () => {
  it('permits public HTTPS URLs when no allowlist is set', () => {
    expect(isUrlAllowed('https://example.com/hook', [])).toBe(true)
  })

  it('permits public HTTP URLs when no allowlist is set', () => {
    expect(isUrlAllowed('http://example.com/hook', [])).toBe(true)
  })

  it('blocks localhost', () => {
    expect(isUrlAllowed('http://localhost/hook', [])).toBe(false)
  })

  it('blocks 127.0.0.1', () => {
    expect(isUrlAllowed('http://127.0.0.1/hook', [])).toBe(false)
  })

  // IPv6 loopback check — Node's URL parser lowercases the hostname
  // so we check for the normalized form.
  it('blocks IPv6 loopback ::1', () => {
    expect(isUrlAllowed('http://[::1]/hook', [])).toBe(false)
  })

  it('blocks RFC-1918 10.x.x.x', () => {
    expect(isUrlAllowed('http://10.0.0.1/hook', [])).toBe(false)
  })

  it('blocks RFC-1918 192.168.x.x', () => {
    expect(isUrlAllowed('http://192.168.1.100/hook', [])).toBe(false)
  })

  it('blocks RFC-1918 172.16-31.x.x', () => {
    expect(isUrlAllowed('http://172.16.0.1/hook', [])).toBe(false)
  })

  it('blocks link-local 169.254.x.x', () => {
    expect(isUrlAllowed('http://169.254.169.254/hook', [])).toBe(false)
  })

  it('blocks non-http/https protocols', () => {
    expect(isUrlAllowed('ftp://example.com/hook', [])).toBe(false)
    expect(isUrlAllowed('file:///etc/passwd', [])).toBe(false)
  })

  it('blocks malformed URLs', () => {
    expect(isUrlAllowed('not-a-url', [])).toBe(false)
  })

  it('allows only hosts in the allowlist when configured', () => {
    const allowlist = ['trusted.example.com']
    expect(isUrlAllowed('https://trusted.example.com/hook', allowlist)).toBe(true)
    expect(isUrlAllowed('https://sub.trusted.example.com/hook', allowlist)).toBe(true)
    expect(isUrlAllowed('https://untrusted.example.com/hook', allowlist)).toBe(false)
  })
})

// ─── Subscriber management ────────────────────────────────────────────────────

describe('subscriber management', () => {
  beforeEach(async () => {
    mockSubscribers.length = 0
  })

  it('addSubscriber creates and stores a subscriber', async () => {
    const sub = await addSubscriber(
      TEST_ORG,
      'https://example.com/hook',
      'secret',
      ['vault_created'],
    )
    expect(sub.id).toBeTruthy()
    expect(sub.active).toBe(true)
    const list = await listSubscribers(TEST_ORG)
    expect(list).toHaveLength(1)
  })

  it('addSubscriber throws for a blocked URL', async () => {
    await expect(
      addSubscriber(TEST_ORG, 'http://localhost/hook', 'secret', []),
    ).rejects.toThrow(/not permitted/i)
  })

  it('removeSubscriber deletes the subscriber', async () => {
    const sub = await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', [])
    const removed = await removeSubscriber(sub.id)
    expect(removed).toBe(true)
    const list = await listSubscribers(TEST_ORG)
    expect(list).toHaveLength(0)
  })

  it('removeSubscriber returns false for unknown id', async () => {
    const result = await removeSubscriber('no-such-id')
    expect(result).toBe(false)
  })
})

// ─── Dispatch and signature verification ─────────────────────────────────────

describe('dispatchWebhookEvent', () => {
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

  const makePayload = (eventType = 'vault_created') => ({
    eventId: 'abc123:0',
    eventType,
    timestamp: new Date().toISOString(),
    data: { vaultId: 'vault-1' },
    organizationId: TEST_ORG,
  })

  it('delivers to a matching subscriber with correct HMAC signature', async () => {
    const secret = 'test-secret'
    await addSubscriber(TEST_ORG, 'https://example.com/hook', secret, ['vault_created'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(true)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://example.com/hook')
    const body = init.body as string
    const sig = (init.headers as Record<string, string>)['x-disciplr-signature']
    expect(verifySignature(secret, body, sig)).toBe(true)
  })

  it('does not deliver to a subscriber that does not subscribe to the event type', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', ['vault_completed'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(results).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delivers to all subscribers when events list is empty (wildcard)', async () => {
    await addSubscriber(TEST_ORG, 'https://a.example.com/hook', 'secretA', [])
    await addSubscriber(TEST_ORG, 'https://b.example.com/hook', 'secretB', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_completed'))

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.success)).toBe(true)
  })

  it('retries on 5xx responses and reports failure after exhausting attempts', async () => {
    await addSubscriber(TEST_ORG, 'https://flaky.example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 503 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(results[0].success).toBe(false)
    expect(results[0].attempts).toBe(1)
    expect(results[0].error).toMatch(/HTTP 503/)
  }, 20_000)

  it('includes the originating eventId in the x-disciplr-event-id header', async () => {
    await addSubscriber(TEST_ORG, 'https://example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    await dispatchWebhookEvent({ ...makePayload(), eventId: 'txhash123:2' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect((init.headers as Record<string, string>)['x-disciplr-event-id']).toBe('txhash123:2')
  })

  it('VAULT_LIFECYCLE_EVENTS contains all four vault event types', () => {
    expect(VAULT_LIFECYCLE_EVENTS.has('vault_created')).toBe(true)
    expect(VAULT_LIFECYCLE_EVENTS.has('vault_completed')).toBe(true)
    expect(VAULT_LIFECYCLE_EVENTS.has('vault_failed')).toBe(true)
    expect(VAULT_LIFECYCLE_EVENTS.has('vault_cancelled')).toBe(true)
  })
})
