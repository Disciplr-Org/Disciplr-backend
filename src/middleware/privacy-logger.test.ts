import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Request, Response, NextFunction } from 'express'
import {
  redact,
  shouldRedact,
  shouldAllow,
  maskIp,
  privacyLogger,
  REDACTED,
  REDACT_MAX_KEYS,
  REDACT_MAX_DEPTH,
  REDACT_MAX_STRING_LENGTH,
  SLOW_REQUEST_THRESHOLD_MS,
} from './privacy-logger'

// ── shouldRedact ──────────────────────────────────────────────────────────────

describe('shouldRedact()', () => {
  it('identifies sensitive keys', () => {
    expect(shouldRedact('password')).toBe(true)
    expect(shouldRedact('token')).toBe(true)
    expect(shouldRedact('authorization')).toBe(true)
    expect(shouldRedact('not_sensitive')).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(shouldRedact('PASSWORD')).toBe(true)
    expect(shouldRedact('ApiKey')).toBe(true)
    expect(shouldRedact('EMAIL')).toBe(true)
  })

  it('matches kebab-case and snake_case variants', () => {
    expect(shouldRedact('client_secret')).toBe(true)
    expect(shouldRedact('access_token')).toBe(true)
    expect(shouldRedact('refresh_token')).toBe(true)
    expect(shouldRedact('x-api-key')).toBe(true)
    expect(shouldRedact('x-auth-token')).toBe(true)
    expect(shouldRedact('credit_card')).toBe(true)
  })

  it('returns false for safe keys', () => {
    expect(shouldRedact('id')).toBe(false)
    expect(shouldRedact('amount')).toBe(false)
  })
})

// ── shouldAllow ───────────────────────────────────────────────────────────────

describe('shouldAllow()', () => {
  it('identifies allowlisted keys', () => {
    expect(shouldAllow('id')).toBe(true)
    expect(shouldAllow('status')).toBe(true)
    expect(shouldAllow('user-agent')).toBe(true)
    expect(shouldAllow('content-type')).toBe(true)
  })

  it('returns false for non-allowlisted keys', () => {
    expect(shouldAllow('not_allowed')).toBe(false)
    expect(shouldAllow('amount')).toBe(false)
  })
})

// ── redact() — basic ──────────────────────────────────────────────────────────

describe('redact() — basic behavior', () => {
  it('passes through primitives unchanged', () => {
    expect(redact(42)).toBe(42)
    expect(redact(true)).toBe(true)
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
  })

  it('redacts sensitive fields', () => {
    expect(redact({ password: 'secret', other: 'data' })).toEqual({
      password: REDACTED,
      other: 'data',
    })
  })

  it('redacts emails and JWTs', () => {
    expect(redact({ field: 'user@example.com' })).toEqual({ field: REDACTED })
    expect(redact({ tok: 'header.payload.signature' })).toEqual({ tok: REDACTED })
  })

  it('uses allowlist mode correctly', () => {
    const input = { id: '123', secret: 'abc', other: 'def' }
    expect(redact(input, new WeakSet(), true)).toEqual({
      id: '123',
      secret: REDACTED,
      other: REDACTED,
    })
  })

  it('recursively redacts nested objects', () => {
    expect(redact({ user: { email: 'a@b.com', name: 'Bob' } })).toEqual({
      user: { email: REDACTED, name: 'Bob' },
    })
  })

  it('handles cyclic references without throwing', () => {
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
})

// ── redact() — bounds ─────────────────────────────────────────────────────────

describe('redact() — bounds invariants', () => {
  it('truncates long strings before regex to prevent ReDoS', () => {
    const longSafe = 'a'.repeat(REDACT_MAX_STRING_LENGTH + 100)
    expect(() => redact({ field: longSafe })).not.toThrow()
  })

  it('replaces with REDACTED when depth exceeds REDACT_MAX_DEPTH', () => {
    let nested: Record<string, unknown> = { value: 'leaf' }
    for (let i = 0; i < REDACT_MAX_DEPTH; i++) nested = { child: nested }
    const result = redact(nested) as Record<string, unknown>
    let cursor: unknown = result
    for (let i = 0; i < REDACT_MAX_DEPTH - 1; i++) {
      cursor = (cursor as Record<string, unknown>).child
    }
    expect((cursor as Record<string, unknown>).child).toBe(REDACTED)
  })

  it('caps key processing at REDACT_MAX_KEYS — overflow keys are redacted', () => {
    const input: Record<string, string> = {}
    for (let i = 0; i < REDACT_MAX_KEYS + 10; i++) input[`field${i}`] = `value${i}`
    const result = redact(input) as Record<string, unknown>
    const redactedCount = Object.values(result).filter((v) => v === REDACTED).length
    expect(redactedCount).toBeGreaterThanOrEqual(10)
  })

  it('does not throw on adversarially large nested payloads', () => {
    const bigPayload: Record<string, unknown> = {}
    for (let i = 0; i < 500; i++) bigPayload[`k${i}`] = { nested: `value${i}` }
    expect(() => redact(bigPayload)).not.toThrow()
  })
})

// ── maskIp() ──────────────────────────────────────────────────────────────────

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

// ── privacyLogger middleware ───────────────────────────────────────────────────

describe('privacyLogger middleware', () => {
  let consoleSpy: jest.SpiedFunction<typeof console.log>
  let finishHandler: () => void
  let closeHandler: () => void
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

  function buildRes(statusCode = 200): Partial<Response> {
    const handlers: Record<string, () => void> = {}
    return {
      statusCode,
      writableEnded: false,
      on(event: string, handler: () => void) {
        handlers[event] = handler
        if (event === 'finish') finishHandler = handler
        if (event === 'close') closeHandler = handler
        return this as Response
      },
    } as Partial<Response>
  }

  function triggerAndParse(): Record<string, unknown> {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    return JSON.parse((consoleSpy.mock.calls[0] as string[])[0])
  }

  beforeEach(() => {
    consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    next = jest.fn()
    finishHandler = () => {}
    closeHandler = () => {}
    req = buildReq()
    res = buildRes()
  })

  afterEach(() => {
    consoleSpy.mockRestore()
    jest.restoreAllMocks()
  })

  // ── schema ──

  it('always calls next()', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('emits exactly one JSON line on response finish', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
    expect(() => JSON.parse((consoleSpy.mock.calls[0] as string[])[0])).not.toThrow()
  })

  it('log line has correct level, event, and service fields', () => {
    const line = triggerAndParse()
    expect(line.level).toBe('info')
    expect(line.event).toBe('http.request')
    expect(line.service).toBe('disciplr-backend')
  })

  it('strips query string from logged url', () => {
    req = buildReq({ url: '/api/vaults?secret=123', originalUrl: '/api/vaults?secret=123' })
    const line = triggerAndParse()
    expect(line.url).toBe('/api/vaults')
    expect(String(line.url)).not.toContain('secret=')
  })

  it('captures method and status', () => {
    res = buildRes(201)
    const line = triggerAndParse()
    expect(line.method).toBe('POST')
    expect(line.status).toBe(201)
  })

  it('includes a numeric durationMs >= 0', () => {
    const line = triggerAndParse()
    expect(typeof line.durationMs).toBe('number')
    expect(line.durationMs as number).toBeGreaterThanOrEqual(0)
  })

  it('includes a valid ISO timestamp', () => {
    const line = triggerAndParse()
    expect(new Date(line.timestamp as string).toISOString()).toBe(line.timestamp)
  })

  // ── slow-request tagging ──

  it('emits level warn and slow:true when duration exceeds threshold', () => {
    let callCount = 0
    jest.spyOn(Date, 'now').mockImplementation(() =>
      callCount++ === 0 ? 1000 : 1000 + SLOW_REQUEST_THRESHOLD_MS + 1,
    )
    const line = triggerAndParse()
    expect(line.level).toBe('warn')
    expect(line.slow).toBe(true)
  })

  it('does NOT set slow:true for fast requests', () => {
    const line = triggerAndParse()
    expect(line.slow).toBeUndefined()
    expect(line.level).toBe('info')
  })

  // ── silent paths ──

  it('emits no log for /health', () => {
    req = buildReq({ url: '/health', originalUrl: '/health' })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('emits no log for /api/health', () => {
    req = buildReq({ url: '/api/health', originalUrl: '/api/health' })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  it('emits no log for /api/metrics', () => {
    req = buildReq({ url: '/api/metrics', originalUrl: '/api/metrics' })
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    expect(consoleSpy).not.toHaveBeenCalled()
  })

  // ── lifecycle idempotency ──

  it('finish handler is a no-op when called a second time (idempotent)', () => {
    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()
    finishHandler()
    expect(consoleSpy).toHaveBeenCalledTimes(1)
  })

  // ── ip masking ──

  it('masks IPv4 addresses', () => {
    const line = triggerAndParse()
    expect(line.ip).toBe('192.168.x.x')
  })

  it('returns "unknown" when ip is absent', () => {
    req = buildReq({ ip: undefined, socket: { remoteAddress: undefined } as never })
    const line = triggerAndParse()
    expect(line.ip).toBe('unknown')
  })

  // ── body / query / headers ──

  it('sets body to null when req.body is absent', () => {
    req = buildReq({ body: undefined })
    expect(triggerAndParse().body).toBeNull()
  })

  it('redacts sensitive fields in body', () => {
    req = buildReq({ body: { password: 'secret', amount: 50 } })
    expect((triggerAndParse().body as Record<string, unknown>).password).toBe(REDACTED)
  })

  it('sets query to null when query is empty', () => {
    req = buildReq({ query: {} })
    expect(triggerAndParse().query).toBeNull()
  })

  it('redacts authorization header', () => {
    req = buildReq({ headers: { authorization: 'Bearer eyJ.eyJ.sig' } })
    expect(
      (triggerAndParse().headers as Record<string, unknown>).authorization,
    ).toBe(REDACTED)
  })

  it('preserves safe headers', () => {
    req = buildReq({ headers: { 'content-type': 'application/json' } })
    expect(
      (triggerAndParse().headers as Record<string, unknown>)['content-type'],
    ).toBe('application/json')
  })

  // ── adversarial inputs ──

  it('handles oversized body without throwing', () => {
    const bigBody: Record<string, string> = {}
    for (let i = 0; i < REDACT_MAX_KEYS + 5; i++) bigBody[`field${i}`] = `value${i}`
    req = buildReq({ body: bigBody })
    expect(() => triggerAndParse()).not.toThrow()
  })

  it('handles deeply-nested body without stack overflow', () => {
    let nested: Record<string, unknown> = { leaf: 'value' }
    for (let i = 0; i < 20; i++) nested = { child: nested }
    req = buildReq({ body: nested })
    expect(() => triggerAndParse()).not.toThrow()
  })

  // ── error path ──

  it('emits minimal 3-field fallback log on serialization failure', () => {
    let callCount = 0
    const origStringify = JSON.stringify
    jest.spyOn(JSON, 'stringify').mockImplementation((...args: unknown[]) => {
      callCount++
      if (callCount === 1) throw new Error('serialization failure')
      return (origStringify as (...a: unknown[]) => string)(...args)
    })

    privacyLogger(req as Request, res as Response, next as unknown as NextFunction)
    finishHandler()

    const fallback = JSON.parse((consoleSpy.mock.calls[0] as string[])[0])
    expect(fallback.level).toBe('error')
    expect(fallback.event).toBe('privacy-logger.serialization-failure')
    expect(fallback).toHaveProperty('timestamp')
    expect(Object.keys(fallback)).toHaveLength(3)
  })
})
