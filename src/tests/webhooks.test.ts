import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import {
  signPayload,
  verifySignature,
  isUrlAllowed,
  addSubscriber,
  removeSubscriber,
  listSubscribers,
  resetSubscribers,
  dispatchWebhookEvent,
  VAULT_LIFECYCLE_EVENTS,
} from '../services/webhooks.js'

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
  beforeEach(() => resetSubscribers())
  afterEach(() => resetSubscribers())

  it('addSubscriber creates and stores a subscriber', () => {
    const sub = addSubscriber('https://example.com/hook', 'secret', ['vault_created'])
    expect(sub.id).toBeTruthy()
    expect(sub.active).toBe(true)
    expect(listSubscribers()).toHaveLength(1)
  })

  it('addSubscriber throws for a blocked URL', () => {
    expect(() => addSubscriber('http://localhost/hook', 'secret', [])).toThrow(/not permitted/i)
  })

  it('removeSubscriber deletes the subscriber', () => {
    const sub = addSubscriber('https://example.com/hook', 'secret', [])
    expect(removeSubscriber(sub.id)).toBe(true)
    expect(listSubscribers()).toHaveLength(0)
  })

  it('removeSubscriber returns false for unknown id', () => {
    expect(removeSubscriber('no-such-id')).toBe(false)
  })
})

// ─── Dispatch and signature verification ─────────────────────────────────────

describe('dispatchWebhookEvent', () => {
  let fetchMock: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    resetSubscribers()
    fetchMock = jest.fn<typeof fetch>()
    global.fetch = fetchMock as any
  })

  afterEach(() => {
    resetSubscribers()
    jest.restoreAllMocks()
  })

  const makePayload = (eventType = 'vault_created') => ({
    eventId: 'abc123:0',
    eventType,
    timestamp: new Date().toISOString(),
    data: { vaultId: 'vault-1' },
  })

  it('delivers to a matching subscriber with correct HMAC signature', async () => {
    const secret = 'test-secret'
    addSubscriber('https://example.com/hook', secret, ['vault_created'])
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
    addSubscriber('https://example.com/hook', 'secret', ['vault_completed'])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(results).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('delivers to all subscribers when events list is empty (wildcard)', async () => {
    addSubscriber('https://a.example.com/hook', 'secretA', [])
    addSubscriber('https://b.example.com/hook', 'secretB', [])
    fetchMock.mockResolvedValue({ status: 200 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_completed'))

    expect(results).toHaveLength(2)
    expect(results.every((r) => r.success)).toBe(true)
  })

  it('retries on 5xx responses and reports failure after exhausting attempts', async () => {
    addSubscriber('https://flaky.example.com/hook', 'secret', [])
    fetchMock.mockResolvedValue({ status: 503 } as Response)

    const results = await dispatchWebhookEvent(makePayload('vault_created'))

    expect(results[0].success).toBe(false)
    expect(results[0].attempts).toBeGreaterThan(1)
    expect(results[0].error).toMatch(/HTTP 503/)
  }, 20_000)

  it('includes the originating eventId in the x-disciplr-event-id header', async () => {
    addSubscriber('https://example.com/hook', 'secret', [])
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
