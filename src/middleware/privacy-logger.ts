import { Request, Response, NextFunction } from 'express'

export const REDACTED = '[REDACTED]'

const SENSITIVE_KEYS = new Set([
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

export const SAFE_LOG_KEYS = new Set([
  'accept',
  'content-type',
  'correlationid',
  'cursor',
  'durationms',
  'event',
  'host',
  'id',
  'ip',
  'level',
  'limit',
  'method',
  'page',
  'pagesize',
  'path',
  'requestid',
  'request_id',
  'route',
  'service',
  'sortby',
  'sortorder',
  'status',
  'statuscode',
  'timestamp',
  'type',
  'url',
  'user-agent',
  'x-correlation-id',
  'x-request-id',
])

const EMAIL_RE = /[^@\s]+@[^@\s]+\.[^@\s]+/
const JWT_RE = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/

export interface RedactOptions {
  allowlistMode?: boolean
  allowedKeys?: Iterable<string>
}

/** Returns true when a field name should always be redacted. */
export function shouldRedact(key: string): boolean {
  return SENSITIVE_KEYS.has(key.toLowerCase())
}

/** Returns true when a field name is safe to keep in allowlist-mode logs. */
export function isSafeLogKey(key: string, allowedKeys: Iterable<string> = SAFE_LOG_KEYS): boolean {
  const normalized = new Set(Array.from(allowedKeys, (allowedKey) => allowedKey.toLowerCase()))
  return normalized.has(key.toLowerCase())
}

/**
 * Pure recursive redactor. Deep-copies input and replaces:
 * - values under sensitive field names, and
 * - string values matching email or JWT patterns
 * with REDACTED. In allowlist mode, non-sensitive keys are only kept when they
 * are explicitly allowlisted. Never mutates the original.
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const allowedKeys = new Set(Array.from(options.allowedKeys ?? SAFE_LOG_KEYS, (key) => key.toLowerCase()))
  return redactValue(value, options.allowlistMode === true, allowedKeys, new WeakSet())
}

function redactValue<T>(value: T, allowlistMode: boolean, allowedKeys: Set<string>, seen: WeakSet<object>): T {
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
    return value.map((item) => redactValue(item, allowlistMode, allowedKeys, seen)) as unknown as T
  }

  if (value instanceof Date) return value.toISOString() as unknown as T
  if (value instanceof RegExp) return value.toString() as unknown as T
  if (Buffer.isBuffer(value)) return '[Buffer]' as unknown as T

  const result: Record<string, unknown> = {}

  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (shouldRedact(k) || (allowlistMode && !allowedKeys.has(k.toLowerCase()))) {
      result[k] = REDACTED
      continue
    }
    result[k] = redactValue(v, allowlistMode, allowedKeys, seen)
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
 */
export const privacyLogger = (
  req: Request,
  res: Response,
  next: NextFunction,
): void => {
  const start = Date.now()

  res.on('finish', () => {
    try {
      const rawIp = req.ip ?? req.socket?.remoteAddress ?? ''
      const rawBody = req.body
      const rawQuery = req.query as Record<string, unknown>

      const line: LogLine = {
        timestamp: new Date().toISOString(),
        level: 'info',
        event: 'http.request',
        service: 'disciplr-backend',
        method: req.method,
        url: req.url,
        status: res.statusCode,
        durationMs: Date.now() - start,
        ip: rawIp ? maskIp(rawIp) : 'unknown',
        body:
          rawBody !== null &&
          rawBody !== undefined &&
          typeof rawBody === 'object' &&
          !Array.isArray(rawBody)
            ? redact(rawBody as Record<string, unknown>, { allowlistMode: true })
            : null,
        query:
          rawQuery && Object.keys(rawQuery).length > 0
            ? redact(rawQuery, { allowlistMode: true })
            : null,
        headers: redact(req.headers as Record<string, unknown>, { allowlistMode: true }),
      }

      console.log(JSON.stringify(line))
    } catch {
      console.log(
        JSON.stringify({
          level: 'error',
          event: 'privacy-logger.serialization-failure',
          timestamp: new Date().toISOString(),
        }),
      )
    }
  })

  next()
}
