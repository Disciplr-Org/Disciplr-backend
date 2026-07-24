import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import {
  addSubscriber,
  dispatchWebhookEvent,
  isUrlAllowed,
  resetSubscribers,
} from '../services/webhooks.js'

describe('webhook SSRF guard', () => {
  beforeEach(() => {
    resetSubscribers()
    delete process.env.WEBHOOK_ALLOWED_HOSTS
  })

  afterEach(() => {
    resetSubscribers()
    delete process.env.WEBHOOK_ALLOWED_HOSTS
    jest.restoreAllMocks()
  })

  const payload = {
    eventId: 'tx:0',
    eventType: 'vault_created',
    timestamp: '2026-06-26T00:00:00.000Z',
    data: { vaultId: 'vault-1' },
  }

  it.each([
    ['cloud metadata endpoint', 'http://169.254.169.254/latest/meta-data'],
    ['decimal encoded metadata endpoint', 'http://2852039166/latest/meta-data'],
    ['hex encoded metadata endpoint', 'http://0xa9fea9fe/latest/meta-data'],
    ['IPv6-mapped metadata endpoint', 'http://[::ffff:169.254.169.254]/latest/meta-data'],
    ['IPv6-mapped hex metadata endpoint', 'http://[::ffff:a9fe:a9fe]/latest/meta-data'],
    ['IPv6 loopback', 'http://[::1]/hook'],
    ['loopback with trailing dot', 'http://localhost./hook'],
    ['DNS-rebinding-style loopback hostname', 'http://hook.localtest.me/callback'],
  ])('blocks %s', (_label, url) => {
    expect(isUrlAllowed(url, [])).toBe(false)
    expect(() => addSubscriber(url, 'secret', [])).toThrow(/not permitted/i)
  })

  it('enforces WEBHOOK_ALLOWED_HOSTS while still blocking internal targets', () => {
    process.env.WEBHOOK_ALLOWED_HOSTS = 'hooks.example.com'

    expect(isUrlAllowed('https://hooks.example.com/webhook')).toBe(true)
    expect(isUrlAllowed('https://tenant.hooks.example.com/webhook')).toBe(true)
    expect(isUrlAllowed('https://evil.example.com/webhook')).toBe(false)
    expect(isUrlAllowed('http://169.254.169.254/latest/meta-data')).toBe(false)
  })

  it('refuses redirects instead of following an allowed host to an internal target', async () => {
    const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
      status: 302,
      headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data' }),
    } as Response)
    global.fetch = fetchMock as any
    jest.spyOn(console, 'error').mockImplementation(() => undefined)

    addSubscriber('https://hooks.example.com/webhook', 'secret', ['vault_created'])

    const results = await dispatchWebhookEvent(payload)

    expect(results).toHaveLength(1)
    expect(results[0].success).toBe(false)
    expect(results[0].error).toMatch(/redirect refused/i)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).not.toHaveBeenCalledWith(
      'http://169.254.169.254/latest/meta-data',
      expect.anything(),
    )
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect(init.redirect).toBe('manual')
    }
  }, 20_000)
})
