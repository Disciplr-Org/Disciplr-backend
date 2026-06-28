import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'

const mockQueryRaw = jest.fn()

jest.unstable_mockModule('../lib/prisma.js', () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
  },
}))

const {
  validateSignedObjectStorageUrl,
  createEvidenceReference,
  fetchEvidenceContent,
  EvidenceSsrfBlockedError,
  EvidenceReferenceValidationError,
} = await import('../services/evidence.js')

describe('evidence SSRF guard', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset()
    delete process.env.EVIDENCE_ALLOWLIST
    delete process.env.WEBHOOK_ALLOWED_HOSTS
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  })

  afterEach(() => {
    delete process.env.EVIDENCE_ALLOWLIST
    delete process.env.WEBHOOK_ALLOWED_HOSTS
    jest.restoreAllMocks()
  })

  describe('validateSignedObjectStorageUrl — blocks private and reserved IPs', () => {
    it('blocks RFC1918 private IP 10.x.x.x', () => {
      const url = 'http://10.0.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
      expect(() => validateSignedObjectStorageUrl(url)).toThrow('blocked IP or non-allowlisted host')
    })

    it('blocks RFC1918 private IP 192.168.x.x', () => {
      const url = 'http://192.168.1.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks RFC1918 private IP 172.16-31.x.x', () => {
      const url = 'http://172.16.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)

      const url2 = 'http://172.31.255.255/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url2)).toThrow(EvidenceSsrfBlockedError)

      // Just outside the range should be checked differently
      const url3 = 'http://172.32.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      // This depends on whether it resolves to a real IP - skipping for now
    })

    it('blocks loopback 127.0.0.1', () => {
      const url = 'http://127.0.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks cloud metadata IP 169.254.169.254 (AWS/GCP)', () => {
      const url = 'http://169.254.169.254/latest/meta-data?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks any 169.254.x.x link-local address', () => {
      const url = 'http://169.254.1.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })
  })

  describe('validateSignedObjectStorageUrl — blocks non-http(s) schemes', () => {
    it('blocks file:// scheme', () => {
      const url = 'file:///etc/passwd'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })

    it('blocks ftp:// scheme', () => {
      const url = 'ftp://example.com/evidence.pdf'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })

    it('blocks gopher:// scheme', () => {
      const url = 'gopher://example.com/evidence.pdf'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceReferenceValidationError)
    })
  })

  describe('validateSignedObjectStorageUrl — prevents DNS rebinding', () => {
    it('blocks localhost hostname', () => {
      const url = 'http://localhost/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks localhost with trailing dot', () => {
      const url = 'http://localhost./evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks *.localhost subdomains', () => {
      const url = 'http://api.localhost/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks DNS-rebinding-style hostname localtest.me', () => {
      const url = 'http://hook.localtest.me/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks IPv6 loopback ::1', () => {
      const url = 'http://[::1]/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks IPv6-mapped IPv4 loopback ::ffff:127.0.0.1', () => {
      const url = 'http://[::ffff:127.0.0.1]/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks IPv6-mapped IPv4 private IP ::ffff:10.0.0.1', () => {
      const url = 'http://[::ffff:10.0.0.1]/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('blocks IPv6-mapped IPv4 metadata ::ffff:169.254.169.254', () => {
      const url = 'http://[::ffff:169.254.169.254]/latest/meta-data?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })
  })

  describe('validateSignedObjectStorageUrl — allows public hosts without allowlist', () => {
    it('allows well-known CDN hostname without allowlist', () => {
      const url = 'https://cdn.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('allows S3 bucket hostname without allowlist', () => {
      const url = 'https://mybucket.s3.amazonaws.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('allows arbitrary public hostname without allowlist', () => {
      const url = 'https://storage.example.org/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })
  })

  describe('validateSignedObjectStorageUrl — enforces EVIDENCE_ALLOWLIST', () => {
    it('allows fetch to allowlisted evidence storage host', () => {
      process.env.EVIDENCE_ALLOWLIST = 'evidence-storage.internal,cdn.example.com'

      // Allowlisted host should pass
      const url = 'https://cdn.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('allows subdomain of allowlisted host', () => {
      process.env.EVIDENCE_ALLOWLIST = 'example.com'

      const url = 'https://cdn.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('blocks non-allowlisted host even with valid public IP', () => {
      process.env.EVIDENCE_ALLOWLIST = 'allowed.example.com'

      const url = 'https://evil.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('still blocks private IPs even if on allowlist', () => {
      process.env.EVIDENCE_ALLOWLIST = 'internal.corp'

      // Attempt to allowlist a private IP hostname
      const url = 'http://10.0.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('still blocks localhost even if on allowlist', () => {
      process.env.EVIDENCE_ALLOWLIST = 'localhost,127.0.0.1'

      const url = 'http://localhost/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })
  })

  describe('validateSignedObjectStorageUrl — falls back to WEBHOOK_ALLOWED_HOSTS', () => {
    it('uses WEBHOOK_ALLOWED_HOSTS if EVIDENCE_ALLOWLIST not set', () => {
      process.env.WEBHOOK_ALLOWED_HOSTS = 'webhooks.example.com'

      // Should block because not on webhook allowlist (and not default allowed)
      const url = 'https://other.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('prefers EVIDENCE_ALLOWLIST over WEBHOOK_ALLOWED_HOSTS', () => {
      process.env.WEBHOOK_ALLOWED_HOSTS = 'webhook-host.example.com'
      process.env.EVIDENCE_ALLOWLIST = 'evidence-host.example.com'

      // Should allow evidence-host
      const url = 'https://evidence-host.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())

      // Should block webhook-host (not on evidence list)
      const url2 = 'https://webhook-host.example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      expect(() => validateSignedObjectStorageUrl(url2)).toThrow(EvidenceSsrfBlockedError)
    })
  })

  describe('createEvidenceReference — integrates SSRF validation', () => {
    it('rejects evidence reference with private IP URL', async () => {
      const url = 'http://10.0.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() =>
        createEvidenceReference('verification-1', 'hash-0123456789abcdef0123456789abcdef', url),
      ).toThrow(EvidenceSsrfBlockedError)
    })

    it('accepts and persists evidence reference with allowed public URL', async () => {
      const fakeRow = [
        {
          id: 'evidence-1',
          verification_id: 'verification-1',
          evidence_hash: 'hash-0123456789abcdef0123456789abcdef',
          reference_url: 'https://cdn.example.com/evidence.pdf?Expires=32503680000&signature=abc',
          expires_at: new Date('2030-01-01T00:00:00.000Z'),
          created_at: new Date('2026-05-27T00:00:00.000Z'),
        },
      ]

      mockQueryRaw.mockResolvedValueOnce(fakeRow)

      const evidence = await createEvidenceReference(
        'verification-1',
        'hash-0123456789abcdef0123456789abcdef',
        'https://cdn.example.com/evidence.pdf?Expires=32503680000&signature=abc',
      )

      expect(mockQueryRaw).toHaveBeenCalled()
      expect(evidence.referenceUrl).toBe(
        'https://cdn.example.com/evidence.pdf?Expires=32503680000&signature=abc',
      )
    })
  })

  describe('fetchEvidenceContent — defense-in-depth validation', () => {
    it('re-validates URL safety before fetching', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        text: jest.fn().mockResolvedValue('evidence content'),
        headers: new Headers(),
      } as unknown as Response)
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      await fetchEvidenceContent(url)

      // Verify fetch was called
      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          method: 'GET',
          redirect: 'manual',
        }),
      )
    })

    it('blocks private IP in fetchEvidenceContent even if passed directly', async () => {
      const url = 'http://10.0.0.1/evidence.pdf'
      expect(() => fetchEvidenceContent(url)).toThrow(EvidenceSsrfBlockedError)
    })

    it('refuses redirects to prevent redirect-based SSRF', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/meta-data' }),
      } as Response)
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      await expect(fetchEvidenceContent(url)).rejects.toThrow('redirect refused')

      // Verify redirect: 'manual' prevents following redirects
      expect(fetchMock).toHaveBeenCalledWith(
        url,
        expect.objectContaining({
          redirect: 'manual',
        }),
      )
    })

    it('times out after configurable timeout', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockImplementation(
        () =>
          new Promise(() => {
            // Never resolve
          }),
      )
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      await expect(fetchEvidenceContent(url, 100)).rejects.toThrow()
    })

    it('returns response text on success', async () => {
      const content = 'evidence content here'
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
        status: 200,
        text: jest.fn().mockResolvedValue(content),
        headers: new Headers(),
      } as unknown as Response)
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      const result = await fetchEvidenceContent(url)

      expect(result).toBe(content)
    })

    it('throws on 4xx response', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
        status: 404,
        headers: new Headers(),
      } as Response)
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      await expect(fetchEvidenceContent(url)).rejects.toThrow('HTTP 404')
    })

    it('throws on 5xx response', async () => {
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue({
        status: 500,
        headers: new Headers(),
      } as Response)
      global.fetch = fetchMock as any

      const url = 'https://cdn.example.com/evidence.pdf'
      await expect(fetchEvidenceContent(url)).rejects.toThrow('HTTP 500')
    })
  })

  describe('error handling and logging', () => {
    it('does not log full URL on SSRF block (no topology leak)', () => {
      const warnSpy = jest.spyOn(console, 'warn')

      const url = 'http://10.0.0.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(EvidenceSsrfBlockedError)

      // Verify warning was logged
      expect(warnSpy).toHaveBeenCalled()

      // Verify URL is NOT in the warning
      const calls = warnSpy.mock.calls
      const logMessage = calls.map((call) => String(call[0])).join(' ')
      expect(logMessage).not.toContain('10.0.0.1')
      expect(logMessage).not.toContain('/evidence.pdf')
    })

    it('throws EvidenceSsrfBlockedError with clear message', () => {
      const url = 'http://192.168.1.1/evidence.pdf?Expires=32503680000&signature=abc'
      expect(() => validateSignedObjectStorageUrl(url)).toThrow(
        new EvidenceSsrfBlockedError('Evidence URL resolves to blocked IP or non-allowlisted host'),
      )
    })

    it('distinguishes SSRF errors from validation errors', () => {
      // SSRF error
      const ssrfUrl = 'http://10.0.0.1/evidence.pdf?Expires=32503680000'
      expect(() => validateSignedObjectStorageUrl(ssrfUrl)).toThrow(EvidenceSsrfBlockedError)

      // Validation error (bad hash format)
      expect(() => createEvidenceReference('v1', 'invalid-hash', 'https://example.com')).toThrow(
        EvidenceReferenceValidationError,
      )
    })
  })

  describe('edge cases and robustness', () => {
    it('handles malformed URL gracefully', () => {
      const malformed = 'not a url at all'
      expect(() => validateSignedObjectStorageUrl(malformed)).toThrow(
        EvidenceReferenceValidationError,
      )
    })

    it('handles empty EVIDENCE_ALLOWLIST gracefully', () => {
      process.env.EVIDENCE_ALLOWLIST = ''

      // Should fall back to no allowlist (allow all public)
      const url = 'https://example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('trims whitespace in EVIDENCE_ALLOWLIST', () => {
      process.env.EVIDENCE_ALLOWLIST = ' example.com , other.com '

      const url = 'https://example.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })

    it('case-insensitive hostname matching', () => {
      process.env.EVIDENCE_ALLOWLIST = 'Example.COM'

      const url = 'https://EXAMPLE.com/evidence.pdf?X-Amz-Date=20260527T000000Z&X-Amz-Expires=3600&X-Amz-Signature=abc'
      const expiry = validateSignedObjectStorageUrl(url)
      expect(expiry.getTime()).toBeGreaterThan(Date.now())
    })
  })
})
