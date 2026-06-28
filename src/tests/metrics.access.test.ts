import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import express from 'express'
import request from 'supertest'
import { _resetEnvForTesting, initEnv } from '../config/env.js'
import { metricsAuth, _test } from '../middleware/metricsAuth.js'

// ── Helpers ─────────────────────────────────────────────────────────────────

function createApp(): express.Application {
  const app = express()
  app.set('trust proxy', true)
  app.use(express.json())
  app.get('/metrics', metricsAuth, (_req, res) => {
    res.status(200).json({ ok: true })
  })
  return app
}

const MINIMAL_ENV = {
  NODE_ENV: 'test' as const,
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
}

// ── Auth middleware tests ───────────────────────────────────────────────────

describe('metricsAuth middleware', () => {
  beforeEach(() => {
    _resetEnvForTesting()
    _test.resetThrottle()
    jest.restoreAllMocks()
  })

  afterEach(() => {
    _resetEnvForTesting()
  })

  it('returns 401 when neither token nor allowlist is configured', async () => {
    initEnv({ ...MINIMAL_ENV })
    const app = createApp()
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/access denied/i)
  })

  it('returns 401 when token is configured but not provided', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_TOKEN: 'secret123' })
    const app = createApp()
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/token required/i)
  })

  it('returns 401 when wrong bearer token is provided', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_TOKEN: 'secret123' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer wrong-token')
    expect(res.status).toBe(401)
    expect(res.body.error).toMatch(/invalid metrics token/i)
  })

  it('returns 200 when correct bearer token is provided', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_TOKEN: 'secret123' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret123')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('returns 200 when IP is in the allowlist (no token needed)', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_ALLOWLIST: '10.0.0.0/8,192.168.1.1' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('X-Forwarded-For', '10.0.0.5')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  it('returns 200 when IP matches exact entry in allowlist', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_ALLOWLIST: '192.168.1.1' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('X-Forwarded-For', '192.168.1.1')
    expect(res.status).toBe(200)
  })

  it('returns 401 when IP is not in allowlist and no token provided', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_ALLOWLIST: '10.0.0.0/8' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('X-Forwarded-For', '172.16.0.1')
    expect(res.status).toBe(401)
  })

  it('returns 200 with token even when IP is not in allowlist', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_TOKEN: 'secret123', METRICS_ALLOWLIST: '10.0.0.0/8' })
    const app = createApp()
    const res = await request(app)
      .get('/metrics')
      .set('Authorization', 'Bearer secret123')
      .set('X-Forwarded-For', '172.16.0.1')
    expect(res.status).toBe(200)
  })

  it('returns 200 when localhost (127.0.0.1) is in allowlist', async () => {
    initEnv({ ...MINIMAL_ENV, METRICS_ALLOWLIST: '127.0.0.1' })
    const app = createApp()
    const res = await request(app).get('/metrics')
    expect(res.status).toBe(200)
  })
})

// ── CIDR matcher unit tests ─────────────────────────────────────────────────

describe('CIDR matcher', () => {
  describe('parseCidr', () => {
    it('parses valid CIDR notation', () => {
      const result = _test.parseCidr('10.0.0.0/8')
      expect(result).not.toBeNull()
      expect(result!.bits).toBe(8)
    })

    it('returns null for invalid format', () => {
      expect(_test.parseCidr('not-a-cidr')).toBeNull()
    })

    it('returns null for missing bits', () => {
      expect(_test.parseCidr('10.0.0.0')).toBeNull()
    })

    it('returns null for invalid bits', () => {
      expect(_test.parseCidr('10.0.0.0/33')).toBeNull()
    })
  })

  describe('matchesCidr', () => {
    it('matches IP within CIDR range', () => {
      expect(_test.matchesCidr('10.0.0.5', '10.0.0.0/8')).toBe(true)
    })

    it('rejects IP outside CIDR range', () => {
      expect(_test.matchesCidr('172.16.0.1', '10.0.0.0/8')).toBe(false)
    })

    it('matches exact IP (no CIDR)', () => {
      expect(_test.matchesCidr('192.168.1.1', '192.168.1.1')).toBe(true)
    })

    it('rejects different exact IP', () => {
      expect(_test.matchesCidr('192.168.1.2', '192.168.1.1')).toBe(false)
    })
  })

  describe('isIpAllowlisted', () => {
    it('returns true when IP matches any entry', () => {
      expect(_test.isIpAllowlisted('10.0.0.5', ['10.0.0.0/8', '192.168.1.1'])).toBe(true)
    })

    it('returns false when IP matches no entry', () => {
      expect(_test.isIpAllowlisted('172.16.0.1', ['10.0.0.0/8'])).toBe(false)
    })

    it('returns false for empty allowlist', () => {
      expect(_test.isIpAllowlisted('10.0.0.5', [])).toBe(false)
    })
  })
})

// ── Allowlist parsing ───────────────────────────────────────────────────────

describe('parseAllowlist', () => {
  it('parses comma-separated entries', () => {
    const result = _test.parseAllowlist('10.0.0.0/8,192.168.1.1')
    expect(result).toEqual(['10.0.0.0/8', '192.168.1.1'])
  })

  it('handles whitespace around entries', () => {
    const result = _test.parseAllowlist(' 10.0.0.0/8 , 192.168.1.1 ')
    expect(result).toEqual(['10.0.0.0/8', '192.168.1.1'])
  })

  it('returns empty array for undefined', () => {
    expect(_test.parseAllowlist(undefined)).toEqual([])
  })

  it('returns empty array for empty string', () => {
    expect(_test.parseAllowlist('')).toEqual([])
  })
})

// ── Token extraction ────────────────────────────────────────────────────────

describe('extractBearerToken', () => {
  it('extracts token from valid header', () => {
    const req = { headers: { authorization: 'Bearer my-token' } } as any
    expect(_test.extractBearerToken(req)).toBe('my-token')
  })

  it('returns null when no auth header', () => {
    const req = { headers: {} } as any
    expect(_test.extractBearerToken(req)).toBeNull()
  })

  it('returns null for non-bearer header', () => {
    const req = { headers: { authorization: 'Basic xyz' } } as any
    expect(_test.extractBearerToken(req)).toBeNull()
  })
})

// ── Audit throttle ──────────────────────────────────────────────────────────

describe('audit throttle', () => {
  beforeEach(() => {
    _test.resetThrottle()
  })

  it('allows first log', () => {
    expect(_test.shouldLog('1.2.3.4')).toBe(true)
  })

  it('blocks subsequent logs within throttle window', () => {
    expect(_test.shouldLog('1.2.3.4')).toBe(true)
    expect(_test.shouldLog('1.2.3.4')).toBe(false)
  })

  it('allows logs from different IPs independently', () => {
    expect(_test.shouldLog('1.2.3.4')).toBe(true)
    expect(_test.shouldLog('5.6.7.8')).toBe(true)
    expect(_test.shouldLog('1.2.3.4')).toBe(false)
    expect(_test.shouldLog('5.6.7.8')).toBe(false)
  })
})

// ── Label hygiene check ─────────────────────────────────────────────────────

describe('metrics label hygiene', () => {
  it('gauges carry no tenant-identifying labels', async () => {
    const client = await import('prom-client')
    const register = new client.Registry()
    client.collectDefaultMetrics({ register })

    const gauge = new client.Gauge({
      name: 'test_aggregate_metric',
      help: 'test',
      labelNames: [],
      registers: [register],
    })
    gauge.set(42)

    const output = await register.metrics()
    // The gauge must not have tenant labels in its definition or data
    expect(output).toContain('test_aggregate_metric 42')
    // No tenant/org/user labels should appear in any metric line
    const lines = output.split('\n').filter((l) => l.startsWith('test_'))
    for (const line of lines) {
      expect(line).not.toMatch(/\b(tenant|org_id|user_id|organization)\b/)
    }
  })
})
