import { Request, Response, NextFunction } from 'express'
import { getEnv } from '../config/env.js'

// ── IPv4 CIDR matcher ─────────────────────────────────────────────────────────

function parseCidr(cidr: string): { network: number; bits: number } | null {
  const parts = cidr.split('/')
  if (parts.length !== 2) return null
  const bits = parseInt(parts[1]!, 10)
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return null
  const octets = parts[0]!.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null
  const network =
    ((octets[0]! << 24) >>> 0) +
    ((octets[1]! << 16) >>> 0) +
    ((octets[2]! << 8) >>> 0) +
    octets[3]!
  return { network, bits }
}

function normalizeIp(raw: string): string {
  // Strip IPv6-mapped IPv4 prefix (::ffff:1.2.3.4 → 1.2.3.4)
  if (raw.startsWith('::ffff:')) return raw.slice(7)
  // Strip zone ID from IPv6 link-local addresses (fe80::1%eth0 → fe80::1)
  const zoneIdx = raw.indexOf('%')
  if (zoneIdx !== -1) return raw.slice(0, zoneIdx)
  return raw
}

function ipToInt(ip: string): number | null {
  const octets = ip.split('.').map(Number)
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) return null
  return (
    ((octets[0]! << 24) >>> 0) +
    ((octets[1]! << 16) >>> 0) +
    ((octets[2]! << 8) >>> 0) +
    octets[3]!
  )
}

// ── IPv6 support ──────────────────────────────────────────────────────────────

/**
 * Expand an IPv6 address to its full 8-group form.
 * Returns null if the address is not a valid IPv6 string.
 */
function expandIpv6(ip: string): string | null {
  // Must contain at least one colon and no dots (that would be IPv4-mapped,
  // already handled by normalizeIp stripping the ::ffff: prefix)
  if (!ip.includes(':')) return null

  const halves = ip.split('::')
  if (halves.length > 2) return null // multiple '::' is invalid

  const leftGroups = halves[0] ? halves[0].split(':') : []
  const rightGroups = halves.length === 2 && halves[1] ? halves[1].split(':') : []

  // Validate every group is a valid 1-4 hex digit token
  const allGroups = [...leftGroups, ...rightGroups]
  if (allGroups.some((g) => !/^[0-9a-fA-F]{1,4}$/.test(g))) return null

  const missing = 8 - leftGroups.length - rightGroups.length
  if (missing < 0) return null
  if (halves.length === 1 && leftGroups.length !== 8) return null

  const expanded = [
    ...leftGroups,
    ...Array<string>(missing).fill('0000'),
    ...rightGroups,
  ].map((g) => g.padStart(4, '0'))

  if (expanded.length !== 8) return null
  return expanded.join(':')
}

/**
 * Convert a fully-expanded IPv6 address to a 128-bit value represented as a
 * pair of 64-bit BigInt halves [high, low].
 */
function ipv6ToBigInt(expandedIp: string): bigint | null {
  const groups = expandedIp.split(':')
  if (groups.length !== 8) return null
  try {
    return groups.reduce<bigint>((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n)
  } catch {
    return null
  }
}

/**
 * Parse an IPv6 CIDR string (e.g. "2001:db8::/32") into its network address
 * as a BigInt and prefix length.  Returns null for non-IPv6 or malformed input.
 */
function parseIpv6Cidr(cidr: string): { network: bigint; bits: number } | null {
  const slashIdx = cidr.lastIndexOf('/')
  if (slashIdx === -1) return null
  const bits = parseInt(cidr.slice(slashIdx + 1), 10)
  if (Number.isNaN(bits) || bits < 0 || bits > 128) return null
  const addr = cidr.slice(0, slashIdx)
  const expanded = expandIpv6(addr)
  if (!expanded) return null
  const network = ipv6ToBigInt(expanded)
  if (network === null) return null
  return { network, bits }
}

/**
 * Returns true when ip is a plain IPv6 address (no CIDR slash) and equals
 * the expanded form of the entry, or when it falls within an IPv6 CIDR block.
 */
function matchesIpv6Entry(ip: string, entry: string): boolean {
  const expandedIp = expandIpv6(ip)
  if (!expandedIp) return false
  const ipVal = ipv6ToBigInt(expandedIp)
  if (ipVal === null) return false

  if (!entry.includes('/')) {
    // Plain IPv6 address comparison — normalise both sides
    const expandedEntry = expandIpv6(entry)
    if (!expandedEntry) return false
    return expandedIp === expandedEntry
  }

  const parsed = parseIpv6Cidr(entry)
  if (!parsed) return false
  const mask = parsed.bits === 0 ? 0n : (~0n << BigInt(128 - parsed.bits)) & ((1n << 128n) - 1n)
  return (ipVal & mask) === (parsed.network & mask)
}

function matchesCidr(ip: string, cidr: string): boolean {
  // Try IPv4 path first
  const parsed = parseCidr(cidr)
  if (parsed) {
    const addr = ipToInt(ip)
    if (addr === null) return false
    const mask = ~0 << (32 - parsed.bits)
    return (addr & mask) >>> 0 === (parsed.network & mask) >>> 0
  }

  // Fall through to IPv6
  if (ip.includes(':') || cidr.includes(':')) {
    return matchesIpv6Entry(ip, cidr)
  }

  // Neither IPv4 CIDR nor IPv6 — treat as exact string match
  return ip === cidr
}

// ── Allowlist parsing ───────────────────────────────────────────────────────

function parseAllowlist(raw: string | undefined): string[] {
  if (!raw || raw.trim() === '') return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isIpAllowlisted(ip: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => matchesCidr(ip, entry))
}

// ── Bearer token extraction ─────────────────────────────────────────────────

function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) return null
  return header.slice(7).trim()
}

// ── Rate-limited audit logger ───────────────────────────────────────────────

const THROTTLE_MS = 60_000
const lastLog = new Map<string, number>()

function shouldLog(ip: string): boolean {
  const now = Date.now()
  const last = lastLog.get(ip)
  if (last !== undefined && now - last < THROTTLE_MS) return false
  lastLog.set(ip, now)
  return true
}

function auditLog(ip: string, allowed: boolean, reason: string): void {
  if (!shouldLog(ip)) return
  console.log(
    JSON.stringify({
      level: 'info',
      event: allowed ? 'metrics.scrape' : 'metrics.scrape_denied',
      ip,
      allowed,
      reason,
      timestamp: new Date().toISOString(),
      service: 'disciplr-backend',
    }),
  )
}

// ── Middleware ───────────────────────────────────────────────────────────────

export function metricsAuth(req: Request, res: Response, next: NextFunction): void {
  const ip = normalizeIp(req.ip ?? req.socket.remoteAddress ?? 'unknown')
  const env = getEnv()
  const token = extractBearerToken(req)
  const allowlist = parseAllowlist(env.METRICS_ALLOWLIST)
  const configuredToken = env.METRICS_TOKEN

  // 1. IP allowlist check
  if (isIpAllowlisted(ip, allowlist)) {
    auditLog(ip, true, 'allowlisted_ip')
    next()
    return
  }

  // 2. Bearer token check
  if (configuredToken && token) {
    if (token === configuredToken) {
      auditLog(ip, true, 'valid_token')
      next()
      return
    }
    auditLog(ip, false, 'invalid_token')
    res.status(401).json({ error: 'Unauthorized: invalid metrics token' })
    return
  }

  // 3. Token configured but not provided
  if (configuredToken && !token) {
    auditLog(ip, false, 'missing_token')
    res.status(401).json({ error: 'Unauthorized: metrics token required' })
    return
  }

  // 4. Neither token nor allowlist match
  auditLog(ip, false, 'not_allowlisted')
  res.status(401).json({ error: 'Unauthorized: access denied' })
}

// ── Exported for testing ────────────────────────────────────────────────────

export const _test = {
  parseCidr,
  ipToInt,
  matchesCidr,
  parseAllowlist,
  isIpAllowlisted,
  extractBearerToken,
  shouldLog,
  normalizeIp,
  resetThrottle: () => lastLog.clear(),
  // IPv6 helpers
  expandIpv6,
  ipv6ToBigInt,
  parseIpv6Cidr,
  matchesIpv6Entry,
}
