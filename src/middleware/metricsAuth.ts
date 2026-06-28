import { Request, Response, NextFunction } from 'express'
import { getEnv } from '../config/env.js'

// ── CIDR matcher (no external deps) ──────────────────────────────────────────

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

function matchesCidr(ip: string, cidr: string): boolean {
  const parsed = parseCidr(cidr)
  if (!parsed) return ip === cidr
  const addr = ipToInt(ip)
  if (addr === null) return false
  const mask = ~0 << (32 - parsed.bits)
  return (addr & mask) >>> 0 === (parsed.network & mask) >>> 0
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
}
