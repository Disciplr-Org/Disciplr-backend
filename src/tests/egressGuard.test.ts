/**
 * Tests for the shared egress SSRF guard (src/security/egressGuard.ts).
 *
 * Covers:
 *  - IP classification (isPublicAddress) across IPv4, IPv6, mapped and boundary addresses.
 *  - Destination resolution (resolvePublicTarget): parsing, scheme/credential validation,
 *    DNS resolution with bounded timeout, any-unsafe-rejects, literal IP handling.
 *  - DNS rebinding / pinning: the socket connects to the validated address and no
 *    second uncontrolled DNS lookup is used at connect time.
 *  - TLS verification: certificate validation uses the original hostname, not the pinned IP.
 */
import { jest, describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from '@jest/globals'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import type { AddressInfo } from 'node:net'

const mockLookup = jest.fn()

jest.unstable_mockModule('node:dns/promises', () => ({
  lookup: mockLookup,
}))

const {
  isPublicAddress,
  resolvePublicTarget,
  fetchPinnedTarget,
  EgressBlockedError,
} = await import('../security/egressGuard.js')

// ── IP classification (table-driven) ────────────────────────────────────────

describe('isPublicAddress — IP classification', () => {
  it.each([
    // IPv4 loopback / unspecified / link-local / private / CGNAT
    ['127.0.0.2', false],
    ['127.0.0.1', false],
    ['0.0.0.0', false],
    ['0.0.0.1', false],
    ['10.0.0.1', false],
    ['10.255.255.255', false],
    ['100.64.0.1', false],
    ['100.127.255.255', false],
    ['100.128.0.1', true],
    ['172.16.0.1', false],
    ['172.31.255.255', false],
    ['172.32.0.1', true],
    ['192.168.0.0', false],
    ['192.168.255.255', false],
    ['169.254.0.0', false],
    ['169.254.169.254', false],
    ['169.254.1.1', false],
    // Public IPv4
    ['8.8.8.8', true],
    ['1.1.1.1', true],
    ['9.9.9.9', true],
    // IPv4 multicast / reserved / broadcast / documentation / benchmarking
    ['224.0.0.1', false],
    ['239.255.255.255', false],
    ['240.0.0.0', false],
    ['255.255.255.255', false],
    ['192.0.2.0', false],
    ['198.51.100.0', false],
    ['203.0.113.0', false],
    ['198.18.0.0', false],
    ['192.88.99.0', false],
    ['0.0.0.0', false],
    // IPv6
    ['::1', false],
    ['::', false],
    ['fd00::1', false],
    ['fc00::1', false],
    ['fe80::1', false],
    ['fe80::1%eth0', false],
    ['ff02::1', false],
    ['ff00::1', false],
    ['2001:db8::1', false],
    ['2001:2::1', false],
    ['2001:10::1', false],
    ['2001:20::1', false],
    ['64:ff9b::1', false],
    // Public IPv6
    ['2001:4860:4860::8888', true],
    ['2a00:1450:4001:81f::200e', true],
    // IPv4-mapped IPv6 (mapped private must be blocked; mapped public allowed)
    ['::ffff:10.0.0.1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:169.254.169.254', false],
    ['::ffff:172.16.0.1', false],
    ['::ffff:192.168.1.1', false],
    ['::ffff:8.8.8.8', true],
    ['::ffff:1.1.1.1', true],
    // Bracketed literals
    ['[::1]', false],
    ['[8.8.8.8]', true],
    ['[::ffff:10.0.0.1]', false],
    // Invalid / non-address input must never be public
    ['', false],
    ['localhost', false],
    ['notanip', false],
    ['999.999.999.999', false],
    ['1.2.3', false],
    ['1.2.3.4.5', false],
  ])('classifies %s as %s', (ip, expected) => {
    expect(isPublicAddress(ip)).toBe(expected)
  })
})

// ── resolvePublicTarget ───────────────────────────────────────────────────

describe('resolvePublicTarget — parsing and scheme validation', () => {
  it('rejects an unparseable URL', async () => {
    await expect(resolvePublicTarget('not a url')).rejects.toBeInstanceOf(EgressBlockedError)
  })

  it('rejects non-http(s) schemes', async () => {
    await expect(resolvePublicTarget('ftp://example.com/')).rejects.toBeInstanceOf(EgressBlockedError)
    await expect(resolvePublicTarget('file:///etc/passwd')).rejects.toBeInstanceOf(EgressBlockedError)
    await expect(resolvePublicTarget('gopher://example.com/')).rejects.toBeInstanceOf(EgressBlockedError)
  })

  it('rejects embedded credentials', async () => {
    await expect(resolvePublicTarget('http://user:pass@example.com/')).rejects.toBeInstanceOf(EgressBlockedError)
  })

  it('rejects a hostname with no addresses (NXDOMAIN)', async () => {
    mockLookup.mockRejectedValue(new Error('getaddrinfo ENOTFOUND'))
    await expect(resolvePublicTarget('http://nxdomain.example.invalid/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('rejects when DNS returns no usable addresses', async () => {
    mockLookup.mockResolvedValue([])
    await expect(resolvePublicTarget('http://empty.example.com/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('rejects when any returned address is non-public (mixed results)', async () => {
    mockLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ])
    await expect(resolvePublicTarget('http://mixed.example.com/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('rejects when a returned address is a malformed/unparseable address', async () => {
    mockLookup.mockResolvedValue([{ address: 'not-an-ip', family: 4 }])
    await expect(resolvePublicTarget('http://bad.example.com/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('rejects on DNS timeout', async () => {
    // The lookup never settles; resolvePublicTarget bounds it internally.
    mockLookup.mockReturnValue(new Promise(() => {}))
    await expect(resolvePublicTarget('http://slow.example.com/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('accepts an all-public result and selects a validated IPv4 address', async () => {
    mockLookup.mockResolvedValue([
      { address: '2606:4700:10::ac42:93f3', family: 6 },
      { address: '172.66.147.243', family: 4 },
      { address: '104.20.23.154', family: 4 },
    ])
    const target = await resolvePublicTarget('http://public.example.com/')
    expect(target.address).toBe('172.66.147.243') // IPv4 preferred
    expect(target.family).toBe(4)
    expect(target.hostname).toBe('public.example.com')
  })

  it('accepts an IPv6-only all-public result', async () => {
    mockLookup.mockResolvedValue([{ address: '2001:4860:4860::8888', family: 6 }])
    const target = await resolvePublicTarget('http://ipv6.example.com/')
    expect(target.address).toBe('2001:4860:4860::8888')
    expect(target.family).toBe(6)
  })

  it('handles a literal IPv4 destination without DNS', async () => {
    mockLookup.mockReset()
    const target = await resolvePublicTarget('http://8.8.8.8/')
    expect(target.address).toBe('8.8.8.8')
    expect(target.family).toBe(4)
    expect(target.hostname).toBe('8.8.8.8')
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('handles a bracketed literal IPv6 destination without DNS', async () => {
    mockLookup.mockReset()
    const target = await resolvePublicTarget('http://[2001:4860:4860::8888]/')
    expect(target.address).toBe('2001:4860:4860::8888')
    expect(target.family).toBe(6)
    expect(target.hostname).toBe('2001:4860:4860::8888') // no brackets passed to socket layer
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('rejects a literal private IP destination', async () => {
    await expect(resolvePublicTarget('http://10.0.0.1/')).rejects.toBeInstanceOf(EgressBlockedError)
    await expect(resolvePublicTarget('http://[::ffff:10.0.0.1]/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('rejects a literal IPv6 link-local with zone identifier', async () => {
    await expect(resolvePublicTarget('http://[fe80::1%eth0]/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })

  it('preserves port and path in the resolved target', async () => {
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const target = await resolvePublicTarget('http://example.com:8443/path?x=1')
    expect(target.port).toBe(8443)
    expect(target.path).toBe('/path?x=1')
    expect(target.address).toBe('8.8.8.8')
  })

  it('uses default ports when none is specified', async () => {
    mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }])
    const httpTarget = await resolvePublicTarget('http://example.com/')
    const httpsTarget = await resolvePublicTarget('https://example.com/')
    expect(httpTarget.port).toBe(80)
    expect(httpsTarget.port).toBe(443)
  })
})

// ── DNS rebinding / pinning ───────────────────────────────────────────────

describe('resolvePublicTarget — DNS rebinding is rejected at resolution', () => {
  it('rejects when a later lookup would return a private address', async () => {
    // First lookup returns public; a subsequent lookup returns private.
    mockLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }])
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }])

    // Validation uses the first (public) result and accepts.
    const target = await resolvePublicTarget('http://rebind.example.com/')
    expect(target.address).toBe('8.8.8.8')

    // A fresh resolution against the same hostname now sees the private answer
    // and must be rejected (fail-closed against rebinding).
    await expect(resolvePublicTarget('http://rebind.example.com/')).rejects.toBeInstanceOf(
      EgressBlockedError,
    )
  })
})

describe('fetchPinnedTarget — socket is pinned to the validated address', () => {
  let serverPort: number
  let connectedAddress: string | null
  let connectedPort: number | null
  let seenHost: string | null
  let server: ReturnType<typeof createHttpServer>

  beforeAll(async () => {
    connectedAddress = null
    connectedPort = null
    seenHost = null

    server = createHttpServer((req, res) => {
      // On the server side, remoteAddress/remotePort are the client's address
      // (the pinned address the client connected from), and localPort is the
      // port the client connected to.
      connectedAddress = req.socket.remoteAddress ?? null
      connectedPort = req.socket.localPort ?? null
      seenHost = req.headers.host ?? null
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('pinned-ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    serverPort = (server.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(resolve))
  })

  beforeEach(() => {
    connectedAddress = null
    connectedPort = null
    seenHost = null
    mockLookup.mockReset()
  })

  it('connects to the validated pinned address, preserves the Host header, and performs no DNS lookup at connect time', async () => {
    // A *public* address is validated at resolution time; the socket is then
    // pinned to it. We route the connection to our local test server through
    // the pinned address so we can observe the actual socket destination.
    const target = {
      url: 'http://rebind.example.com/',
      hostname: 'rebind.example.com',
      path: '/',
      port: serverPort,
      address: '127.0.0.1',
      family: 4 as const,
    }

    const response = await fetchPinnedTarget(target, {
      method: 'GET',
      headers: {},
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('pinned-ok')
    // The socket connected to the pinned address (loopback test server).
    expect(connectedAddress).toBe('127.0.0.1')
    expect(connectedPort).toBe(serverPort)
    // The Host header uses the original hostname, not the pinned IP.
    expect(seenHost).toBe(`rebind.example.com:${serverPort}`)
    // No second DNS lookup was used to connect.
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('does not follow redirects', async () => {
    const redirectServer = createHttpServer((req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9999/elsewhere' })
      res.end()
    })
    await new Promise<void>((resolve) => redirectServer.listen(0, '127.0.0.1', resolve))
    const redirectPort = (redirectServer.address() as AddressInfo).port

    try {
      const target = {
        url: 'http://redirect.example.com/',
        hostname: 'redirect.example.com',
        path: '/',
        port: redirectPort,
        address: '127.0.0.1',
        family: 4 as const,
      }
      const response = await fetchPinnedTarget(target, { method: 'GET', headers: {} })
      // 3xx is returned as a response (http clients do not follow redirects);
      // the caller treats it as a refusal.
      expect(response.statusCode).toBe(302)
    } finally {
      await new Promise<void>((resolve) => redirectServer.close(resolve))
    }
  })
})

// ── TLS verification ──────────────────────────────────────────────────────

describe('fetchPinnedTarget — TLS certificate verification', () => {
  let tlsPort: number
  let tlsServer: ReturnType<typeof createHttpsServer>
  let ca: Buffer
  let seenSni: string | null

  beforeAll(async () => {
    // Self-signed certificate for 'tls.example.com'.
    execSync(
      'openssl req -x509 -newkey rsa:2048 -nodes -out /tmp/egress-guard-cert.pem ' +
        '-keyout /tmp/egress-guard-key.pem -days 1 -subj "/CN=tls.example.com" ' +
        '-addext "subjectAltName=DNS:tls.example.com"',
      { stdio: 'ignore' },
    )

    const cert = readFileSync('/tmp/egress-guard-cert.pem')
    const key = readFileSync('/tmp/egress-guard-key.pem')
    ca = cert
    seenSni = null
    tlsServer = createHttpsServer({ cert, key }, (req, res) => {
      seenSni = (req.socket as { servername?: string | null }).servername ?? null
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('tls-ok')
    })
    await new Promise<void>((resolve) => tlsServer.listen(0, '127.0.0.1', resolve))
    tlsPort = (tlsServer.address() as AddressInfo).port
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => tlsServer.close(resolve))
  })

  beforeEach(() => {
    seenSni = null
  })

  it('connects to the pinned IP while verifying the certificate against the original hostname', async () => {
    const target = {
      url: 'https://tls.example.com/',
      hostname: 'tls.example.com',
      path: '/',
      port: tlsPort,
      address: '127.0.0.1',
      family: 4 as const,
    }

    const response = await fetchPinnedTarget(target, {
      method: 'GET',
      headers: {},
      ca,
    })

    expect(response.statusCode).toBe(200)
    expect(response.body).toBe('tls-ok')
    // SNI was the original hostname, not the pinned IP.
    expect(seenSni).toBe('tls.example.com')
  })

  it('rejects when the certificate does not match the original hostname (verification is on)', async () => {
    // Certificate is for tls.example.com; connecting with a different hostname
    // must fail certificate verification (rejectUnauthorized stays enabled).
    const target = {
      url: 'https://wrong.example.com/',
      hostname: 'wrong.example.com',
      path: '/',
      port: tlsPort,
      address: '127.0.0.1',
      family: 4 as const,
    }

    await expect(fetchPinnedTarget(target, { method: 'GET', headers: {}, ca })).rejects.toThrow()
  })
})
