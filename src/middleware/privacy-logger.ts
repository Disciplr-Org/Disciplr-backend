import { Request, Response, NextFunction } from 'express'
import { register as registerLifecycle, get as getLifecycle, transition as transitionLifecycle, deregister as deregisterLifecycle } from '../observability/requestLifecycle.js'

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

/**
 * Pure recursive redactor. Deep-copies input and replaces:
 * - values under sensitive field names, and
 * - string values matching email or JWT patterns
 * with REDACTED. Never mutates the original.
 * If allowlistMode is true, redacts any field not explicitly allowlisted.
 */
export function redact<T>(value: T, seen = new WeakSet(), allowlistMode = false): T {
  if (value === null || value === undefined) return value

  if (typeof value !== 'object') {
    if (typeof value === 'string') {
      if (EMAIL_RE.test(value) || JWT_RE.test(value)) {
        return REDACTED as unknown as T
      }
    }
    return value
  }

  if (seen.has(value as object)) return REDACTED as unknown as T
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen, allowlistMode)) as unknown as T
  }

  if (value instanceof Date) return value.toISOString() as unknown as T
  if (value instanceof RegExp) return value.toString() as unknown as T
  if (Buffer.isBuffer(value)) return '[Buffer]' as unknown as T

  const result: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedact(k)) {
      result[k] = REDACTED
    } else if (allowlistMode && !shouldAllow(k)) {
      result[k] = REDACTED
    } else {
      result[k] = redact(v, seen, allowlistMode)
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
  level: 'info'
  event: 'http.request'
  service: 'disciplr-backend'
  method: string
  url: string
  status: number
  durationMs: number
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
 * via console.log. All PII is redacted before emission.
 * Never mutates req/res. Always calls next().
 *
 * Lifecycle invariants:
 *   - Registers the request in the lifecycle state machine on entry.
 *   - Transitions to ACTIVE when the finish handler begins processing.
 *   - Transitions to COMPLETED after a successful log emission.
 *   - Transitions to FAILED if serialization or emission fails.
 *   - Transitions to CANCELLED if the request lifecycle is deregistered
 *     (e.g. client disconnect before response finishes).
 *   - The finish handler is guarded against double-invocation: if the request
 *     is already in a terminal state (COMPLETED/FAILED/CANCELLED), the handler
 *     is a no-op. This prevents duplicate log lines on retried or interrupted
 *     requests.
 */
export const privacyLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const start = Date.now()
  const requestId = (req as any).correlationId ?? (req as any).requestId ?? `${req.method}-${start}-${Math.random().toString(36).slice(2, 8)}`

  registerLifecycle(requestId, { method: req.method, path: req.originalUrl || req.url })

  res.on('finish', () => {
    // Guard: skip if already in a terminal state (idempotent handler)
    const current = transitionLifecycle(requestId, 'ACTIVE')
    if (current !== 'ACTIVE') return

    try {
      const rawIp = req.ip ?? req.socket?.remoteAddress ?? ''
      const rawBody = req.body
      const rawQuery = req.query as Record<string, unknown>
      
      const tracedReq = req as any
      const correlationId = tracedReq.correlationId
      const traceId = tracedReq.traceContext?.traceId

      const line: LogLine = {
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'http.request',
        service: 'disciplr-backend',
        method: req.method,
        url: (req.originalUrl || req.url).split('?')[0],
        status: res.statusCode,
        durationMs: Date.now() - start,
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
        headers: redact(req.headers as Record<string, unknown>, new WeakSet(), true),
      }

      console.log(JSON.stringify(line))
      transitionLifecycle(requestId, 'COMPLETED')
    } catch {
      transitionLifecycle(requestId, 'FAILED')
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'privacy-logger.serialization-failure',
          timestamp: new Date().toISOString(),
        }),
      )
    }
  })

  // Clean up lifecycle on client disconnect (if response never finishes)
  res.on('close', () => {
    const entry = getLifecycle(requestId)
    if (entry && entry.state === 'CREATED') {
      transitionLifecycle(requestId, 'CANCELLED')
    }
  })

  next()
}