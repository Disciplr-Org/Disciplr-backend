import { Request, Response, NextFunction } from 'express'
import {
  register as registerLifecycle,
  get as getLifecycle,
  transition as transitionLifecycle,
} from '../observability/requestLifecycle.js'
import { transitionOperation } from '../observability/observabilityState.js'

export const REDACTED = '[REDACTED]'

export const SENSITIVE_KEYS = new Set([
  'password',
  'passwordhash',
  'token',
  'accesstoken',
  'refreshtoken',
  'apikey',
  'api_key',
  'secret',
  'authorization',
  'x-api-key',
  'x-auth-token',
  'credential',
  'credentials',
  'ssn',
  'creditcard',
  'credit_card',
  'cvv',
  'pin',
  'cookie',
  // legacy / extra fields
  'clientsecret',
  'email',
  'creator',
  'successdestination',
  'failuredestination',
])

const EMAIL_RE = /[^@\s]+@[^@\s]+\.[^@\s]+/
const JWT_RE = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/

/** Normalize a key by lowering case and stripping separators. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-]/g, '')
}

/** Pre-normalized set for fast lookup. */
const NORMALIZED_SENSITIVE_KEYS = new Set(
  [...SENSITIVE_KEYS].map(normalizeKey),
)

/** Returns true when a field name should always be redacted. */
export function shouldRedact(key: string): boolean {
  return NORMALIZED_SENSITIVE_KEYS.has(normalizeKey(key))
}

export const ALLOWLIST_KEYS = new Set([
  'id',
  'requestid',
  'request_id',
  'route',
  'status',
  // Common safe headers
  'host',
  'user-agent',
  'accept',
  'content-type',
  'content-length',
])

/** Returns true when a field name is explicitly allowlisted. */
export function shouldAllow(key: string): boolean {
  return ALLOWLIST_KEYS.has(key.toLowerCase())
}

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Maximum number of keys visited when redacting an object.
 * Prevents O(n) blowup from adversarially large payloads.
 * Any keys beyond this limit are replaced with REDACTED.
 */
export const REDACT_MAX_KEYS = 64

/**
 * Maximum recursion depth for redact(). Objects deeper than this are
 * replaced with REDACTED rather than recursed into.
 */
export const REDACT_MAX_DEPTH = 8

/**
 * Maximum string length checked against email/JWT regexes.
 * Strings longer than this are truncated before pattern matching to
 * prevent ReDoS on adversarially crafted values.
 */
export const REDACT_MAX_STRING_LENGTH = 2048

/**
 * Slow-request threshold in milliseconds. Requests that exceed this
 * duration get a `slow: true` tag and `level: "warn"` in the log line.
 */
export const SLOW_REQUEST_THRESHOLD_MS = 5_000

/**
 * Paths excluded from privacy logging entirely (health/readiness/metrics).
 * Avoids log-volume pollution from infra polling traffic.
 */
const ALWAYS_SILENT_PATHS = new Set([
  '/health',
  '/ready',
  '/api/health',
  '/api/v1/health',
  '/api/metrics',
])

/**
 * Pure recursive redactor. Deep-copies input and replaces:
 * - values under sensitive field names, and
 * - string values matching email or JWT patterns
 * with REDACTED. Never mutates the original.
 *
 * If allowlistMode is true, redacts any field not explicitly allowlisted.
 *
 * @param maxKeys  Remaining key-visit budget shared across the call tree.
 * @param depth    Current recursion depth.
 */
export function redact<T>(
  value: T,
  seen = new WeakSet(),
  allowlistMode = false,
  maxKeys = REDACT_MAX_KEYS,
  depth = 0,
): T {
  if (value === null || value === undefined) return value

  if (typeof value !== 'object') {
    if (typeof value === 'string') {
      // Truncate before regex to prevent ReDoS on adversarially long strings
      const sample =
        value.length > REDACT_MAX_STRING_LENGTH
          ? value.slice(0, REDACT_MAX_STRING_LENGTH)
          : value
      if (EMAIL_RE.test(sample) || JWT_RE.test(sample)) {
        return REDACTED as unknown as T
      }
    }
    return value
  }

  if (depth >= REDACT_MAX_DEPTH) return REDACTED as unknown as T
  if (seen.has(value as object)) return REDACTED as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) =>
      redact(item, seen, allowlistMode, maxKeys, depth + 1),
    ) as unknown as T
  }

  if (value instanceof Date) return value.toISOString() as unknown as T
  if (value instanceof RegExp) return value.toString() as unknown as T
  if (Buffer.isBuffer(value)) return '[Buffer]' as unknown as T

  const result: Record<string, unknown> = {}
  let keysVisited = 0

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (keysVisited >= maxKeys) {
      result[k] = REDACTED
      continue
    }
    keysVisited++

    if (shouldRedact(k)) {
      result[k] = REDACTED
    } else if (allowlistMode && !shouldAllow(k)) {
      result[k] = REDACTED
    } else {
      result[k] = redact(v, seen, allowlistMode, maxKeys - keysVisited, depth + 1)
    }
  }

  return result as unknown as T
}

/** Mask IPv4 to a.b.x.x, IPv6 to first three groups + xxxx segments. */
export function maskIp(ip: string): string {
  if (!ip) return 'unknown'

  if (ip.includes(':')) {
    const groups = ip.split(':')
    return groups.slice(0, 3).join(':') + ':xxxx:xxxx:xxxx:xxxx:xxxx'
  }

  const parts = ip.split('.')
  if (parts.length === 4) return `${parts[0]}.${parts[1]}.x.x`

  return 'unknown'
}

interface LogLine {
  timestamp: string
  level: 'info' | 'warn'
  event: 'http.request'
  service: 'disciplr-backend'
  method: string
  url: string
  status: number
  durationMs: number
  slow?: true
  ip: string
  traceId?: string
  correlationId?: string
  body: Record<string, unknown> | null
  query: Record<string, unknown> | null
  headers: Record<string, unknown>
}

/**
 * Privacy-hardened request logger middleware.
 *
 * Emits exactly one structured JSON line per request (on response finish)
 * via console.log. All PII is redacted before emission. Never mutates
 * req/res. Always calls next().
 *
 * Invariants enforced:
 *   - Health/metrics paths are silently skipped — no log emitted.
 *   - Body and query are bounded to REDACT_MAX_KEYS/DEPTH/STRING_LENGTH.
 *   - Requests exceeding SLOW_REQUEST_THRESHOLD_MS get level:warn + slow:true.
 *   - Lifecycle state machine tracks each request through CREATED → ACTIVE →
 *     COMPLETED/FAILED/CANCELLED. The finish handler is idempotent: if the
 *     request is already in a terminal state it is a no-op.
 *   - Serialization failures emit a minimal 3-field fallback line.
 */
export const privacyLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const start = Date.now()

  const requestId =
    (req as any).correlationId ??
    (req as any).requestId ??
    `${req.method}-${start}-${Math.random().toString(36).slice(2, 8)}`

  registerLifecycle(requestId, { method: req.method, path: req.originalUrl || req.url })
  transitionOperation(req, 'logging', 'in_progress')

  res.on('finish', () => {
    // Guard: skip if already in a terminal lifecycle state (idempotent handler)
    const current = transitionLifecycle(requestId, 'ACTIVE')
    if (current !== 'ACTIVE') return

    try {
      // Skip noisy infra paths — no log emitted
      const path = (req.originalUrl || req.url).split('?')[0]
      if (ALWAYS_SILENT_PATHS.has(path)) {
        transitionLifecycle(requestId, 'COMPLETED')
        return
      }

      const durationMs = Date.now() - start
      const rawIp = req.ip ?? req.socket?.remoteAddress ?? ''
      const rawBody = req.body
      const rawQuery = req.query as Record<string, unknown>

      const tracedReq = req as Request & {
        correlationId?: string
        traceContext?: { traceId?: string }
      }
      const correlationId = tracedReq.correlationId
      const traceId = tracedReq.traceContext?.traceId

      const line: LogLine = {
        timestamp: new Date().toISOString(),
        level: durationMs >= SLOW_REQUEST_THRESHOLD_MS ? 'warn' : 'info',
        event: 'http.request',
        service: 'disciplr-backend',
        method: req.method,
        url: path,
        status: res.statusCode,
        durationMs,
        ip: rawIp ? maskIp(rawIp) : 'unknown',
        traceId,
        correlationId,
        body:
          rawBody !== null &&
          rawBody !== undefined &&
          typeof rawBody === 'object' &&
          !Array.isArray(rawBody)
            ? redact(rawBody as Record<string, unknown>, new WeakSet(), true)
            : null,
        query:
          rawQuery && Object.keys(rawQuery).length > 0
            ? redact(rawQuery, new WeakSet(), true)
            : null,
        headers: redact(
          req.headers as Record<string, unknown>,
          new WeakSet(),
          true,
        ),
      }

      if (durationMs >= SLOW_REQUEST_THRESHOLD_MS) {
        line.slow = true
      }

      console.log(JSON.stringify(line))
      transitionLifecycle(requestId, 'COMPLETED')
    } catch {
      // The timestamp serialization may itself have thrown (e.g. a mocked
      // Date#toISOString). Fall back to a known epoch string.
      let failureTimestamp: string
      try {
        failureTimestamp = new Date(0).toISOString()
      } catch {
        failureTimestamp = '1970-01-01T00:00:00.000Z'
      }
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'privacy-logger.serialization-failure',
          timestamp: failureTimestamp,
        }),
      )
    }
  })

  // Clean up lifecycle on client disconnect (response never finishes)
  res.on('close', () => {
    const entry = getLifecycle(requestId)
    if (entry && entry.state === 'CREATED') {
      transitionLifecycle(requestId, 'CANCELLED')
    }
  })

  next()
}
