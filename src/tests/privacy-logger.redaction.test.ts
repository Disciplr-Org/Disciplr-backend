import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import { redact, maskIp, shouldRedact, privacyLogger, REDACTED } from '../middleware/privacy-logger.js'

// ---------------------------------------------------------------------------
// redact()
// ---------------------------------------------------------------------------
describe('redact()', () => {
  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })

  it('redacts email-pattern strings by value regardless of key', () => {
    expect(redact({ field: 'user@example.com' })).toEqual({ field: REDACTED })
  })

  it('redacts JWT-pattern strings by value', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    expect(redact({ tok: jwt })).toEqual({ tok: REDACTED })
  })

  it('does not redact non-email, non-JWT plain strings', () => {
    expect(redact({ name: 'Alice' })).toEqual({ name: 'Alice' })
  })

  it('redacts sensitive keys case-insensitively', () => {
    expect(redact({ PASSWORD: 'secret' })).toEqual({ PASSWORD: REDACTED })
    expect(redact({ ApiKey: 'k' })).toEqual({ ApiKey: REDACTED })
    expect(redact({ Authorization: 'Bearer tok' })).toEqual({ Authorization: REDACTED })
    expect(redact({ 'x-api-key': 'k' })).toEqual({ 'x-api-key': REDACTED })
    expect(redact({ 'x-auth-token': 'k' })).toEqual({ 'x-auth-token': REDACTED })
    expect(redact({ cookie: 'session=abc' })).toEqual({ cookie: REDACTED })
  })

  it('redacts all spec-listed sensitive keys', () => {
    const keys = [
      'password', 'passwordHash', 'token', 'accessToken', 'refreshToken',
      'apiKey', 'api_key', 'secret', 'authorization', 'x-api-key',
      'x-auth-token', 'credential', 'credentials', 'ssn', 'creditCard',
      'credit_card', 'cvv', 'pin', 'cookie',
    ]
    for (const k of keys) {
      expect((redact({ [k]: 'value' }) as Record<string, unknown>)[k]).toBe(REDACTED)
    }
  })

  it('leaves non-sensitive fields unchanged', () => {
    expect(redact({ id: 'abc', amount: 100 })).toEqual({ id: 'abc', amount: 100 })
  })

  it('recursively redacts nested objects', () => {
    const input = { user: { email: 'a@b.com', name: 'Bob' } }
    expect(redact(input)).toEqual({ user: { email: REDACTED, name: 'Bob' } })
  })

  it('recursively redacts objects inside arrays', () => {
    const input = { users: [{ id: '1', password: 'x' }, { id: '2', password: 'y' }] }
    expect(redact(input)).toEqual({
      users: [{ id: '1', password: REDACTED }, { id: '2', password: REDACTED }],
    })
  })

  it('handles arrays of primitives without modification', () => {
    expect(redact(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('handles deeply nested PII', () => {
    const input = { a: { b: { c: { apiKey: 'deep-secret' } } } }
    expect(redact(input)).toEqual({ a: { b: { c: { apiKey: REDACTED } } } })
  })

  it('handles circular references without throwing', () => {
    const obj: Record<string, unknown> = { safe: 'value' }
    obj.self = obj
    const result = redact(obj) as Record<string, unknown>
    expect(result.safe).toBe('value')
    expect(result.self).toBe(REDACTED)
  })

  it('does not mutate the original object', () => {
    const input = { password: 'secret', name: 'Alice' }
    const copy = { ...input }
    redact(input)
    expect(input).toEqual(copy)
  })

  it('serializes Date, RegExp, Buffer safely', () => {
    const d = new Date('2024-01-01T00:00:00Z')
    const result = redact({ d, r: /x/, b: Buffer.from('hi') }) as Record<string, unknown>
    expect(result.d).toBe(d.toISOString())
    expect(result.r).toBe('/x/')
    expect(result.b).toBe('[Buffer]')
  })

  it('handles empty object and empty array', () => {
    expect(redact({})).toEqual({})
    expect(redact([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// shouldRedact()
// ---------------------------------------------------------------------------
describe('shouldRedact()', () => {
  it('returns true for known sensitive keys', () => {
    expect(shouldRedact('password')).toBe(true)
    expect(shouldRedact('EMAIL')).toBe(true)   // case-insensitive match
    expect(shouldRedact('email')).toBe(true)
    expect(shouldRedact('token')).toBe(true)
    expect(shouldRedact('cookie')).toBe(true)
  })

  it('returns false for safe keys', () => {
    expect(shouldRedact('id')).toBe(false)
    expect(shouldRedact('name')).toBe(false)
    expect(shouldRedact('status')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// maskIp()
// ---------------------------------------------------------------------------
describe('maskIp()', () => {
  it('masks IPv4 last two octets', () => {
    expect(maskIp('192.168.1.1')).toBe('192.168.x.x')
    expect(maskIp('10.0.0.1')).toBe('10.0.x.x')
  })

  it('masks IPv6 keeping first three groups', () => {
    expect(maskIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334')).toBe(
      '2001:0db8:85a3:xxxx:xxxx:xxxx:xxxx:xxxx',
    )
  })

  it('returns "unknown" for empty or malformed input', () => {
    expect(maskIp('')).toBe('unknown')
    expect(maskIp('not-an-ip')).toBe('unknown')
  })
})

// ---------------------------------------------------------------------------
// privacyLogger middleware
// ---------------------------------------------------------------------------
describe('privacyLogger middleware', () => {
  let consoleSpy: ReturnType<typeof jest.spyOn>
  let finishHandler: () => void
  let req: Partial<Request>
  let res: Partial<Response>
  let next: jest.Mock

  function buildReq(overrides: Partial<Request> = {}): Partial<Request> {
    return {
      method: 'POST',
      url: '/api/vaults',
      ip: '192.168.1.1',
      body: { amount: 100 },
      query: {},
      headers: { 'content-type': 'application/json' },
      socket: { remoteAddress: '192.168.1.1' } as never,
      ...overrides,
    }
  }

  function buildRes(): Partial<Response> {
    const handlers: Record<string, () => void> = {}
    return {
      statusCode: 200,
      on(event: string, handler: () => void) {
        handlers[event] = handler
        if (event === 'finish') finishHandler = handler
        return this as Response
      },
    } as Partial<Response>
  }

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    next = jest.fn()
    finishHandler = () => {}
    req = buildReq()
    res = buildRes()
  })

  afterEach(() => {
    consoleSpy.mockRestore()
  })

  function getLogLine(): Record<string, unknown> {
    finishHandler()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    return JSON.parse((consoleSpy.mock.calls[0] as string[])[0])
  }

  // ---- schema ----

  it('emits exactly one JSON line on response finish', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse((consoleSpy.mock.calls[0] as string[])[0])).not.toThrow()
  })

  it('always calls next()', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('emits the exact stable set of top-level keys', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(Object.keys(line).sort()).toEqual(
      ['body', 'durationMs', 'event', 'headers', 'ip', 'level', 'method', 'query', 'service', 'status', 'timestamp', 'url'],
    )
  })

  it('sets fixed string fields correctly', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.level).toBe('info')
    expect(line.event).toBe('http.request')
    expect(line.service).toBe('disciplr-backend')
  })

  it('captures method, url, and status from req/res', () => {
    ;(res as { statusCode: number }).statusCode = 201
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.method).toBe('POST')
    expect(line.url).toBe('/api/vaults')
    expect(line.status).toBe(201)
  })

  it('includes a numeric durationMs >= 0', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(typeof line.durationMs).toBe('number')
    expect(line.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('includes an ISO timestamp', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(new Date(line.timestamp as string).toISOString()).toBe(line.timestamp)
  })

  // ---- ip masking ----

  it('masks IPv4 addresses in the log line', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.ip).toBe('192.168.x.x')
  })

  it('uses "unknown" when ip is absent', () => {
    req = buildReq({ ip: undefined, socket: { remoteAddress: undefined } as never })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.ip).toBe('unknown')
  })

  // ---- body ----

  it('sets body to null when req.body is absent', () => {
    req = buildReq({ body: undefined })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.body).toBeNull()
  })

  it('sets body to null when req.body is not a plain object', () => {
    req = buildReq({ body: 'raw-string' as never })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.body).toBeNull()
  })

  it('redacts sensitive fields in body', () => {
    req = buildReq({ body: { password: 'secret', amount: 50 } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.body as Record<string, unknown>).password).toBe(REDACTED)
    expect((line.body as Record<string, unknown>).amount).toBe(50)
  })

  // ---- query ----

  it('sets query to null when query is empty', () => {
    req = buildReq({ query: {} })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect(line.query).toBeNull()
  })

  it('includes and redacts non-empty query', () => {
    req = buildReq({ query: { token: 'abc', page: '1' } as never })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.query as Record<string, unknown>).token).toBe(REDACTED)
    expect((line.query as Record<string, unknown>).page).toBe('1')
  })

  // ---- header redaction ----

  it('redacts authorization header', () => {
    req = buildReq({ headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c' } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.headers as Record<string, unknown>).authorization).toBe(REDACTED)
  })

  it('redacts x-api-key header', () => {
    req = buildReq({ headers: { 'x-api-key': 'my-api-key' } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.headers as Record<string, unknown>)['x-api-key']).toBe(REDACTED)
  })

  it('redacts x-auth-token header', () => {
    req = buildReq({ headers: { 'x-auth-token': 'my-auth-token' } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.headers as Record<string, unknown>)['x-auth-token']).toBe(REDACTED)
  })

  it('redacts cookie header', () => {
    req = buildReq({ headers: { cookie: 'session=xyz' } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.headers as Record<string, unknown>).cookie).toBe(REDACTED)
  })

  it('preserves safe headers', () => {
    req = buildReq({ headers: { 'content-type': 'application/json', 'user-agent': 'jest' } })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    const line = getLogLine()
    expect((line.headers as Record<string, unknown>)['content-type']).toBe('application/json')
  })

  // ---- error path ----

  it('emits safe fallback log on serialization failure and still calls next()', () => {
    // Cause redact to surface a non-serializable output by monkey-patching JSON.stringify
    const orig = JSON.stringify
    let callCount = 0
    jest.spyOn(JSON, 'stringify').mockImplementation((...args) => {
      callCount++
      if (callCount === 1) throw new Error('serialization failure')
      return orig.apply(JSON, args as [unknown])
    })

    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()

    const fallback = JSON.parse((consoleSpy.mock.calls[0] as string[])[0])
    expect(fallback.level).toBe('error')
    expect(fallback.event).toBe('privacy-logger.serialization-failure')
    expect(fallback).toHaveProperty('timestamp')
    expect(Object.keys(fallback)).toHaveLength(3)

    jest.restoreAllMocks()
  })

  // ---- snapshot ----

  it('snapshot: structured log line for a request with sensitive fields', () => {
    req = buildReq({
      method: 'POST',
      url: '/api/auth/login',
      ip: '10.20.30.40',
      body: { email: 'user@example.com', password: 'hunter2' },
      query: {},
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        'x-api-key': 'raw-api-key-value',
      },
    })
    ;(res as { statusCode: number }).statusCode = 200

    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()

    const line = JSON.parse((consoleSpy.mock.calls[0] as string[])[0])

    // Replace non-deterministic fields for snapshot stability
    line.timestamp = '2024-01-01T00:00:00.000Z'
    line.durationMs = 0

    expect(line).toMatchSnapshot()

    // Explicit security assertions on top of snapshot
    expect(line.body.email).toBe(REDACTED)
    expect(line.body.password).toBe(REDACTED)
    expect(line.headers.authorization).toBe(REDACTED)
    expect(line.headers['x-api-key']).toBe(REDACTED)
    expect(line.ip).toBe('10.20.x.x')
    expect(line.query).toBeNull()
  })
})
