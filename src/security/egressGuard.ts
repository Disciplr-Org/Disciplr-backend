/**
 * @fileoverview Shared outbound (egress) SSRF guard for Disciplr.
 *
 * Replaces hostname-string allow/block lists with a resolve-validate-pin model:
 * the destination is resolved to IP addresses, every resolved address is
 * classified as public or not, and the actual socket is pinned to a validated
 * public IP so DNS rebinding cannot redirect the connection to an internal
 * address after validation.
 *
 * The IP classifier is the single authoritative implementation used by both
 * webhook delivery and evidence fetching.
 */

/* global AbortController */
import { isIP } from 'node:net'
import { lookup } from 'node:dns/promises'
import { Buffer } from 'node:buffer'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL } from 'node:url'
import http from 'node:http'
import https from 'node:https'

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * Thrown when an egress target is blocked by the SSRF guard.
 *
 * Delivery code treats this as a non-transient, non-retryable failure and
 * records it distinctly as `egress_blocked`.
 */
export class EgressBlockedError extends Error {
  readonly retryable = false

  constructor(message: string) {
    super(message)
    this.name = 'EgressBlockedError'
  }
}

// ── Environment override ────────────────────────────────────────────────────

/**
 * WEBHOOK_ALLOW_PRIVATE=true permits loopback/private destinations.
 *
 * It is only meaningful outside of production: `src/config/env.ts` refuses to
 * start a production process with this flag enabled. The default (unset) is
 * fail-closed: private destinations are always blocked.
 */
const WEBHOOK_ALLOW_PRIVATE = process.env.WEBHOOK_ALLOW_PRIVATE === 'true'

export function isPrivateOverrideEnabled(): boolean {
  return WEBHOOK_ALLOW_PRIVATE
}

// ── IP classification ───────────────────────────────────────────────────────
//
// Reference: IANA Special-Purpose Address Registry (RFC 6890 et al.) plus the
// RFC 1918 private ranges. Every range below is non-globally-reachable and
// must never be an egress destination.
//
// IPv4 entries are expressed as CIDR and matched with 32-bit arithmetic.
// IPv6 entries are expressed as CIDR and matched with 128-bit bigint arithmetic.
// IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) are normalised to their embedded
// IPv4 address before classification, so ::ffff:10.0.0.1 is blocked exactly
// like 10.0.0.1 while ::ffff:8.8.8.8 remains public.

const IPV4_BLOCKED_CIDRS: ReadonlyArray<string> = [
  '0.0.0.0/8', // "this" network
  '10.0.0.0/8', // RFC 1918 private
  '100.64.0.0/10', // carrier-grade NAT
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local
  '172.16.0.0/12', // RFC 1918 private
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // TEST-NET-1 (documentation)
  '192.88.99.0/24', // 6to4 relay anycast (deprecated)
  '192.168.0.0/16', // RFC 1918 private
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // TEST-NET-2 (documentation)
  '203.0.113.0/24', // TEST-NET-3 (documentation)
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved
  '255.255.255.255/32', // limited broadcast
]

const IPV6_BLOCKED_CIDRS: ReadonlyArray<string> = [
  '::/128', // unspecified
  '::1/128', // loopback
  'fc00::/7', // unique-local
  'fe80::/10', // link-local
  'ff00::/8', // multicast
  '2001::/23', // IETF protocol assignments (includes Teredo)
  '2001:db8::/32', // documentation
  '3fff::/20', // documentation
  '2001:2::/48', // benchmarking
  '2001:10::/28', // ORCHID (deprecated)
  '2001:20::/28', // ORCHIDv2
  '64:ff9b::/96', // IPv4/IPv6 translation
  '64:ff9b:1::/48', // IPv4/IPv6 translation
  '2002::/16', // 6to4
]

type IpVersion = 4 | 6

/** Parses a canonical IPv4 dotted-decimal string into a 32-bit unsigned integer. */
function parseIpv4(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let num = 0
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null
    const value = Number.parseInt(part, 10)
    if (value > 255) return null
    num = (num << 8) | value
  }
  return num >>> 0
}

/** Parses an IPv6 string (with optional :: compression) into a 128-bit bigint. */
function parseIpv6(ip: string): bigint | null {
  const hasDoubleColon = ip.includes('::')
  let groups: string[]

  if (hasDoubleColon) {
    const [leftSide, rightSide] = ip.split('::', 2)
    const left = leftSide === '' ? [] : leftSide.split(':').filter(Boolean)
    const right = rightSide === '' ? [] : rightSide.split(':').filter(Boolean)
    const missing = 8 - left.length - right.length
    if (missing < 0) return null
    groups = [...left, ...Array(missing).fill('0'), ...right]
  } else {
    groups = ip.split(':')
    if (groups.length !== 8) return null
  }

  if (groups.length !== 8) return null

  let num = 0n
  for (const group of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null
    num = (num << 16n) + BigInt('0x' + group)
  }
  return num
}

const IPV4_MASK_32 = 0xffffffff
const IPV6_MASK_128 = (1n << 128n) - 1n

function ipv4CidrMatches(ip: number, cidr: string): boolean {
  const [address, prefix] = cidr.split('/')
  const network = parseIpv4(address)
  if (network === null) return false
  const p = Number.parseInt(prefix, 10)
  if (!Number.isFinite(p) || p < 0 || p > 32) return false
  const mask = p === 0 ? 0 : (IPV4_MASK_32 << (32 - p)) >>> 0
  return (ip & mask) === (network & mask)
}

function ipv6CidrMatches(ip: bigint, cidr: string): boolean {
  const [address, prefix] = cidr.split('/')
  const network = parseIpv6(address)
  if (network === null) return false
  const p = Number.parseInt(prefix, 10)
  if (!Number.isFinite(p) || p < 0 || p > 128) return false
  const mask = p === 0 ? 0n : IPV6_MASK_128 << (128n - BigInt(p))
  return (ip & mask) === (network & mask)
}

/**
 * Normalises an IP address string for classification:
 * - strips surrounding brackets (`[::1]` -> `::1`)
 * - strips IPv6 zone identifiers (`fe80::1%eth0` -> `fe80::1`)
 *
 * Returns null for strings that are not valid IP addresses. Note this does
 * not validate the address; callers should parse the result with parseIpv4
 * or parseIpv6.
 */
function normaliseIp(ip: string): string | null {
  if (typeof ip !== 'string' || ip === '') return null

  let cleaned = ip.replace(/^\[|\]$/g, '')

  // Strip IPv6 zone identifier, if present.
  const zoneIndex = cleaned.indexOf('%')
  if (zoneIndex !== -1) cleaned = cleaned.slice(0, zoneIndex)

  if (cleaned === '') return null
  return cleaned
}

/**
 * Returns true when `ip` is a globally reachable public address.
 *
 * Returns false for invalid input, private/RFC1918, loopback, link-local,
 * multicast, reserved, documentation, benchmarking, and all other
 * special-purpose or non-globally-reachable IPv4/IPv6 addresses.
 *
 * Invalid addresses are never classified as public.
 */
export function isPublicAddress(ip: string): boolean {
  const cleaned = normaliseIp(ip)
  if (cleaned === null) return false

  const ipv4 = parseIpv4(cleaned)
  if (ipv4 !== null) {
    return !IPV4_BLOCKED_CIDRS.some((cidr) => ipv4CidrMatches(ipv4, cidr))
  }

  // IPv4-mapped IPv6 written with a dotted-quad suffix (::ffff:a.b.c.d).
  // parseIpv6 cannot parse the trailing dotted quad, so handle it here.
  const mappedDotted = cleaned.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)
  if (mappedDotted) {
    const embedded = parseIpv4(mappedDotted[1])
    if (embedded === null) return false
    return !IPV4_BLOCKED_CIDRS.some((cidr) => ipv4CidrMatches(embedded, cidr))
  }

  const ipv6 = parseIpv6(cleaned)
  if (ipv6 !== null) {
    // IPv4-mapped IPv6 (::ffff:w.x.y.z, also written ::ffff:aabb:ccdd by some
    // resolvers): classify the embedded IPv4 address so ::ffff:10.0.0.1 is
    // blocked exactly like 10.0.0.1 while ::ffff:8.8.8.8 stays public.
    if ((ipv6 >> 32n) === 0xffffn) {
      const embedded = Number(ipv6 & 0xffffffffn) >>> 0
      return !IPV4_BLOCKED_CIDRS.some((cidr) => ipv4CidrMatches(embedded, cidr))
    }
    // Only global-unicast space is eligible for public egress. This rejects
    // deprecated site-local, benchmarking, and currently unallocated ranges
    // outside 2000::/3 even if they are not individually listed below.
    if (!ipv6CidrMatches(ipv6, '2000::/3')) return false
    return !IPV6_BLOCKED_CIDRS.some((cidr) => ipv6CidrMatches(ipv6, cidr))
  }

  return false
}

// ── Destination resolution and pinning ──────────────────────────────────────

export interface EgressTarget {
  /** Normalised URL to trace/log (original hostname preserved for Host/SNI). */
  url: string
  /** Original hostname, used for the HTTP Host header and TLS SNI. */
  hostname: string
  /** Path including query string. */
  path: string
  /** Port to connect to. */
  port: number
  /** Validated public IP address (no brackets, no zone identifier). */
  address: string
  /** Address family of `address`. */
  family: IpVersion
}

const DEFAULT_DNS_TIMEOUT_MS = 5_000

/**
 * Resolves `lookup` with a bounded timeout so an unresponsive DNS server
 * cannot leave the process waiting forever. A timed-out lookup rejects and
 * never triggers a connection.
 */
async function lookupWithTimeout(
  hostname: string,
  timeoutMs: number,
): Promise<Array<{ address: string; family: IpVersion }>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`DNS lookup timed out for ${hostname}`)), timeoutMs)
  })

  try {
    const lookupPromise = lookup(hostname, { all: true })
    // Attach a rejection handler even if timeout wins the race; the resolver
    // operation itself cannot be cancelled through dns/promises.lookup().
    void lookupPromise.catch(() => {})
    return (await Promise.race([lookupPromise, timeout])) as Array<{
      address: string
      family: IpVersion
    }>
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Parses, validates and resolves an egress URL to a single pinned public
 * target.
 *
 * Every address returned by DNS is classified; if any address is non-public
 * the destination is rejected (fail-closed against DNS rebinding at
 * resolution time). The returned `address` is the exact IP the socket will be
 * pinned to by {@link fetchPinnedTarget}.
 */
export async function resolvePublicTarget(
  url: string,
  options: { allowPrivate?: boolean } = {},
): Promise<EgressTarget> {
  const { allowPrivate = isPrivateOverrideEnabled() } = options

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new EgressBlockedError(`Invalid URL: ${url}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new EgressBlockedError(`Unsupported protocol ${parsed.protocol}: ${url}`)
  }

  // Reject embedded credentials — never forward user/pass to an egress target.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new EgressBlockedError(`URL contains embedded credentials: ${url}`)
  }

  const hostname = parsed.hostname
  if (hostname === '') {
    throw new EgressBlockedError(`URL has no hostname: ${url}`)
  }

  // Node may include brackets around IPv6 literals in `hostname` (e.g.
  // `[::1]`); strip them before IP detection. The original `hostname` is
  // preserved separately for the HTTP `Host` header / TLS SNI.
  const unbracketedHostname = hostname.replace(/^\[|\]$/g, '')

  const port =
    parsed.port !== ''
      ? (() => {
          const p = Number.parseInt(parsed.port, 10)
          if (!Number.isFinite(p) || p < 1 || p > 65535) {
            throw new EgressBlockedError(`Invalid port ${parsed.port}: ${url}`)
          }
          return p
        })()
      : parsed.protocol === 'https:'
        ? 443
        : 80

  const path = parsed.pathname + parsed.search

  // Literal IP destination: classify directly, no DNS lookup needed.
  if (isIP(unbracketedHostname) !== 0) {
    const address = normaliseIp(unbracketedHostname)
    if (address === null) {
      throw new EgressBlockedError(`Unable to parse IP address ${unbracketedHostname}: ${url}`)
    }
    const family = isIP(address) as IpVersion
    if (!allowPrivate && !isPublicAddress(address)) {
      throw new EgressBlockedError(`Destination resolves to a non-public address: ${url}`)
    }
    return {
      url: parsed.href,
      hostname: unbracketedHostname,
      path,
      port,
      address,
      family,
    }
  }

  // DNS hostname: resolve and validate every returned address.
  let results: Array<{ address: string; family: IpVersion }>
  try {
    results = await lookupWithTimeout(hostname, DEFAULT_DNS_TIMEOUT_MS)
  } catch (err) {
    throw new EgressBlockedError(
      `DNS resolution failed for ${hostname}: ${err instanceof Error ? err.message : err}`,
    )
  }
  if (!results || results.length === 0) {
    throw new EgressBlockedError(`DNS resolution returned no addresses for ${hostname}`)
  }

  const validated: Array<{ address: string; family: IpVersion }> = []
  for (const result of results) {
    const address = normaliseIp(result.address)
    if (address === null) {
      throw new EgressBlockedError(`DNS returned an unparseable address for ${hostname}`)
    }
    if (!allowPrivate && !isPublicAddress(address)) {
      throw new EgressBlockedError(
        `DNS returned a non-public address ${address} for ${hostname}: ${url}`,
      )
    }
    validated.push({ address, family: result.family })
  }

  // Prefer IPv4 when available for maximal compatibility; the socket is pinned
  // to this exact address regardless of any subsequent DNS change.
  const ipv4 = validated.find(({ family }) => family === 4)
  const selected = ipv4 ?? validated[0]

  return {
    url: parsed.href,
    hostname,
    path,
    port,
    address: selected.address,
    family: selected.family,
  }
}

// ── Pinned HTTP/HTTPS delivery ──────────────────────────────────────────────

export interface PinnedFetchInit {
  method: string
  headers: Record<string, string>
  body?: string | null
  timeoutMs?: number
  /** Maximum response size in bytes; larger responses are aborted. */
  maxResponseBytes?: number
  /** Optional CA certificate(s) used to verify TLS (verification stays enabled). */
  ca?: string | Buffer | Array<string | Buffer>
}

export interface PinnedFetchResponse {
  statusCode: number
  statusMessage: string
  headers: http.IncomingHttpHeaders
  body: string
  ok: boolean
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/**
 * Performs an outbound HTTP/HTTPS request whose socket is pinned to the IP
 * returned by {@link resolvePublicTarget}.
 *
 * A custom `lookup` callback is supplied to `http.request`/`https.request` so
 * the callback cannot silently resolve to a different address: it always
 * returns the validated IP. The original `hostname` is preserved for the HTTP
 * `Host` header and TLS Server Name Indication; TLS certificate verification
 * remains enabled (`rejectUnauthorized` defaults to `true`) and validates
 * against the original hostname.
 *
 * Redirects are not followed (Node's http/https clients do not follow
 * redirects by default); callers must treat any 3xx response as a refusal.
 * Response bodies and sockets are consumed and destroyed so nothing leaks.
 */
export async function fetchPinnedTarget(
  target: EgressTarget,
  init: PinnedFetchInit,
): Promise<PinnedFetchResponse> {
  const { hostname, address, family, port, path, url } = target
  const isHttps = url.startsWith('https:')
  const mod = isHttps ? https : http

  return new Promise<PinnedFetchResponse>((resolve, reject) => {
    const timeoutMs = init.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const maxResponseBytes = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let settled = false
    const isPinnedFetchResponse = (
      value: unknown,
    ): value is PinnedFetchResponse =>
      value !== null &&
      typeof value === 'object' &&
      typeof (value as PinnedFetchResponse).statusCode === 'number'

    const settle = (value: PinnedFetchResponse | Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Use shape discrimination rather than `instanceof Error`: cross-realm
      // errors (e.g. TLS errors surfaced through mocked Node builtins) are not
      // `instanceof` the local `Error` but must still reject the promise.
      if (isPinnedFetchResponse(value)) resolve(value)
      else reject(value as Error)
    }

    controller.signal.addEventListener(
      'abort',
      () => settle(new Error(`Request timed out after ${timeoutMs}ms`)),
      { once: true },
    )

    const req = mod.request(
      {
        method: init.method,
        hostname,
        port,
        path,
        family,
        lookup: (_hostname, _opts, cb) => {
          // Pin to the exact validated address. Ignore any DNS resolution; the
          // callback is the single source of truth for the socket destination.
          cb(null, address, family)
        },
        headers: init.headers,
        signal: controller.signal,
        // TLS: certificate verification stays enabled and validates against the
        // original hostname (servername defaults to `hostname`). Do not disable
        // verification or substitute the pinned IP as the certificate hostname.
        ...(init.ca !== undefined ? { ca: init.ca } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        let responseBytes = 0
        res.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          responseBytes += buffer.length
          if (responseBytes > maxResponseBytes) {
            const error = new Error(`Response exceeded ${maxResponseBytes} bytes`)
            settle(error)
            res.destroy(error)
            req.destroy(error)
            return
          }
          chunks.push(buffer)
        })
        res.on('end', () => {
          res.destroy()
          settle({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300,
          })
        })
        res.on('error', (err: Error) => settle(err))
      },
    )

    req.on('error', (err: Error) => settle(err))
    req.on('abort', () => {
      // Abort already handled by the abort listener; ensure the socket is
      // destroyed so no connection lingers.
      req.destroy()
    })
    req.end(init.body ?? null)
  })
}

/**
 * Convenience wrapper: resolve and validate a URL, then deliver a request to
 * the pinned target. Throws {@link EgressBlockedError} for blocked or
 * unresolvable destinations.
 */
export async function requestToPublicTarget(
  url: string,
  init: PinnedFetchInit,
  options: { allowPrivate?: boolean } = {},
): Promise<PinnedFetchResponse> {
  const target = await resolvePublicTarget(url, options)
  return fetchPinnedTarget(target, init)
}
