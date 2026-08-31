import { describe, expect, it, beforeEach, jest } from '@jest/globals'
import type { Request, Response } from 'express'
import {
  checkAndIncrementExportQuota,
  configureOrgQuotaRepository,
  createInMemoryOrgQuotaRepository,
  resetOrgQuotas,
  utcDateString,
  EXPORT_QUOTA_METRIC,
  type OrgQuotaRepository,
} from '../services/exportQuota.js'
import { resetExportJobs } from '../services/exportQueue.js'
import { initEnv, _resetEnvForTesting } from '../config/index.js'

// Set a dummy DATABASE_URL before env validation runs to prevent fatal error
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://dummy:dummy@dummy/dummy'

// ── auth mock ──────────────────────────────────────────────────────────────
jest.mock('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: () => void) => next(),
  requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
  signDownloadToken: () => 'mock-token',
  verifyDownloadToken: () => null,
}))

// ── helpers ────────────────────────────────────────────────────────────────
type MockResponse = {
  status: (code: number) => MockResponse
  json: (body: unknown) => MockResponse
  setHeader: (name: string, value: string | number) => MockResponse
  send: (body: unknown) => MockResponse
  statusCode?: number
  jsonBody?: unknown
  headers: Record<string, string | number>
}

const mockRes = (): MockResponse => {
  const r: MockResponse = {
    headers: {},
    status(code) { r.statusCode = code; return r },
    json(body) { r.jsonBody = body; return r },
    setHeader(name, value) { r.headers[name] = value; return r },
    send(body) { void body; return r },
  }
  return r
}

const createMockJobSystem = () => ({
  enqueue: jest.fn(() => ({
    id: 'job-1',
    type: 'export.generate',
    runAt: new Date().toISOString(),
    maxAttempts: 3,
  })),
})

let createExportRouter: typeof import('./exports.js').createExportRouter

const getHandler = (
  path: string,
  method: 'post' | 'get',
  jobSystem = createMockJobSystem(),
) => {
  const router = createExportRouter(jobSystem as never)
  const layer = router.stack.find(
    (e) => (e.route as any)?.path === path && Boolean((e.route as any)?.methods?.[method]),
  )
  if (!layer?.route?.stack?.length) throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`);
  return {
    jobSystem,
    handle: layer.route.stack[layer.route.stack.length - 1].handle as (
      req: Request,
      res: Response,
    ) => Promise<void>,
  }
}

// ── setup ──────────────────────────────────────────────────────────────────
beforeEach(async () => {
  _resetEnvForTesting()
  initEnv()
  if (!createExportRouter) {
    createExportRouter = (await import('./exports.js')).createExportRouter
  }
  await resetOrgQuotas()
  await resetExportJobs()
  jest.restoreAllMocks()
})

// ══════════════════════════════════════════════════════════════════════════
// 1. exportQuota service unit tests
// ══════════════════════════════════════════════════════════════════════════
describe('checkAndIncrementExportQuota', () => {
  it('allows first request and increments count', async () => {
    const result = await checkAndIncrementExportQuota('org-a', 5)
    expect(result.allowed).toBe(true)
  })

  it('allows requests up to the limit', async () => {
    const limit = 3
    for (let i = 0; i < limit; i++) {
      const r = await checkAndIncrementExportQuota('org-b', limit)
      expect(r.allowed).toBe(true)
    }
  })

  it('rejects the request that would exceed the limit', async () => {
    const limit = 2
    await checkAndIncrementExportQuota('org-c', limit)
    await checkAndIncrementExportQuota('org-c', limit)
    const result = await checkAndIncrementExportQuota('org-c', limit)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThan(0)
      expect(result.retryAfter).toBeLessThanOrEqual(86400)
    }
  })

  it('treats different orgs independently', async () => {
    await checkAndIncrementExportQuota('org-d', 1)
    const blocked = await checkAndIncrementExportQuota('org-d', 1)
    const allowed = await checkAndIncrementExportQuota('org-e', 1)
    expect(blocked.allowed).toBe(false)
    expect(allowed.allowed).toBe(true)
  })

  it('resets after calling resetOrgQuotas', async () => {
    await checkAndIncrementExportQuota('org-f', 1)
    await resetOrgQuotas()
    const result = await checkAndIncrementExportQuota('org-f', 1)
    expect(result.allowed).toBe(true)
  })

  it('returns retryAfter >0 and <=86400 when blocked', async () => {
    await checkAndIncrementExportQuota('org-g', 1)
    const result = await checkAndIncrementExportQuota('org-g', 1)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThanOrEqual(1)
      expect(result.retryAfter).toBeLessThanOrEqual(86400)
    }
  })
})

describe('configureOrgQuotaRepository', () => {
  it('accepts a custom repository and uses it', async () => {
    let count = 0
    const customRepo: OrgQuotaRepository = {
      incrementIfWithinLimit: jest.fn(async (orgId, date, metric, dailyLimit) => {
        count += 1
        return {
          orgId,
          quotaDate: date,
          metric,
          count,
          limit: dailyLimit,
          updatedAt: new Date().toISOString(),
        }
      }),
      get: jest.fn(async () => undefined),
      reset: jest.fn(async () => undefined),
    }

    configureOrgQuotaRepository(customRepo)
    const result = await checkAndIncrementExportQuota('x', 10)
    expect(result.allowed).toBe(true)
    expect(customRepo.incrementIfWithinLimit).toHaveBeenCalledTimes(1)
    expect(customRepo.incrementIfWithinLimit).toHaveBeenCalledWith('x', utcDateString(), EXPORT_QUOTA_METRIC, 10)

    // Restore the default in-memory repository for the remaining tests
    configureOrgQuotaRepository(createInMemoryOrgQuotaRepository())
    await resetOrgQuotas()
  })
})

describe('utcDateString', () => {
  it('returns YYYY-MM-DD format', () => {
    const d = utcDateString()
    expect(/^\d{4}-\d{2}-\d{2}$/.test(d)).toBe(true)
  })

  it('uses the provided date', () => {
    const d = utcDateString(new Date('2030-06-15T12:00:00Z'))
    expect(d).toBe('2030-06-15')
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 2. Concurrency: quota is enforced consistently under bursts
// ══════════════════════════════════════════════════════════════════════════
describe('Concurrent quota enforcement', () => {
  const LIMIT = 10

  it('admits exactly LIMIT requests out of a 3x concurrent burst', async () => {
    await resetOrgQuotas()
    const N = LIMIT * 3
    const results = await Promise.all(
      Array.from({ length: N }, () => checkAndIncrementExportQuota('burst-org', LIMIT)),
    )

    const accepted = results.filter((r) => r.allowed).length
    const rejected = results.filter((r) => !r.allowed).length
    expect(accepted).toBe(LIMIT)
    expect(rejected).toBe(N - LIMIT)
  })

  it('never lets the stored counter exceed the limit (no over-grant, no overshoot)', async () => {
    const inner = createInMemoryOrgQuotaRepository()
    let maxObservedCount = 0
    const spyRepo: OrgQuotaRepository = {
      incrementIfWithinLimit: async (orgId, date, metric, dailyLimit) => {
        const entry = await inner.incrementIfWithinLimit(orgId, date, metric, dailyLimit)
        if (entry) {
          maxObservedCount = Math.max(maxObservedCount, entry.count)
        }
        return entry
      },
      get: (orgId, date, metric) => inner.get(orgId, date, metric),
      reset: () => inner.reset(),
    }
    configureOrgQuotaRepository(spyRepo)

    const N = 200
    let accepted = 0
    await Promise.all(
      Array.from({ length: N }, async () => {
        const r = await checkAndIncrementExportQuota('spy-org', LIMIT)
        if (r.allowed) accepted += 1
      }),
    )

    expect(accepted).toBe(LIMIT)
    // The atomic conditional increment never writes a count past the limit,
    // even when 20x the limit arrives concurrently.
    expect(maxObservedCount).toBe(LIMIT)

    configureOrgQuotaRepository(createInMemoryOrgQuotaRepository())
    await resetOrgQuotas()
  })

  it('isolates concurrent bursts between different orgs', async () => {
    await resetOrgQuotas()
    const N = LIMIT * 3

    const [org1, org2] = await Promise.all([
      Promise.all(Array.from({ length: N }, () => checkAndIncrementExportQuota('burst-org-1', LIMIT))),
      Promise.all(Array.from({ length: N }, () => checkAndIncrementExportQuota('burst-org-2', LIMIT))),
    ])

    expect(org1.filter((r) => r.allowed).length).toBe(LIMIT)
    expect(org2.filter((r) => r.allowed).length).toBe(LIMIT)
  })

  it('boundary: limit 1 admits exactly one concurrent request', async () => {
    await resetOrgQuotas()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => checkAndIncrementExportQuota('limit-one', 1)),
    )
    expect(results.filter((r) => r.allowed).length).toBe(1)
    expect(results.filter((r) => !r.allowed).length).toBe(9)
  })

  it('boundary: limit 0 rejects every request without writing a counter', async () => {
    await resetOrgQuotas()
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkAndIncrementExportQuota('limit-zero', 0)),
    )
    expect(results.every((r) => !r.allowed)).toBe(true)
  })

  it('boundary: requests after an exhausted quota are rejected with retryAfter', async () => {
    await resetOrgQuotas()
    await Promise.all(
      Array.from({ length: LIMIT }, () => checkAndIncrementExportQuota('boundary-org', LIMIT)),
    )
    const result = await checkAndIncrementExportQuota('boundary-org', LIMIT)
    expect(result.allowed).toBe(false)
    if (!result.allowed) {
      expect(result.retryAfter).toBeGreaterThanOrEqual(1)
      expect(result.retryAfter).toBeLessThanOrEqual(86400)
    }
  })
})

describe('POST /me quota recovery on enqueue failure', () => {
  const makeReq = (userId = 'user-recovery-1') =>
    ({
      query: { format: 'json', scope: 'vaults' },
      user: { userId, role: 'USER' },
      header: () => undefined,
    }) as unknown as Request

  it('does not consume quota when job enqueue fails, allowing a retry', async () => {
    const failingJobSystem = {
      enqueue: jest.fn().mockRejectedValue(new Error('queue down')),
    }
    const { handle } = getHandler('/me', 'post', failingJobSystem as never)
    const { getEnv } = await import('../config/index.js')
    const env = getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    const res1 = mockRes()
    await handle(makeReq('user-recovery-1'), res1 as unknown as Response)
    expect(res1.statusCode).toBe(500)

    const res2 = mockRes()
    await handle(makeReq('user-recovery-1'), res2 as unknown as Response)
    expect(res2.statusCode).toBe(202)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })

  it('rejects concurrent duplicate submissions exactly once when quota limit is 1', async () => {
    const { handle } = getHandler('/me', 'post', createMockJobSystem())
    const { getEnv } = await import('../config/index.js')
    const env = getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    const results = await Promise.all(
      Array.from({ length: 5 }, () => {
        const res = mockRes()
        return handle(makeReq('user-duplicate'), res as unknown as Response).then(() => res)
      }),
    )

    const accepted = results.filter((r) => r.statusCode === 202).length
    const rejected = results.filter((r) => r.statusCode === 429).length
    expect(accepted).toBe(1)
    expect(rejected).toBe(4)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 3. Route integration: POST /me quota enforcement
// ══════════════════════════════════════════════════════════════════════════
describe('POST /me quota enforcement', () => {
  const makeReq = (userId = 'user-quota-1', orgId?: string) =>
    ({
      query: { format: 'json', scope: 'vaults' },
      user: { userId, role: 'USER' },
      header: () => undefined,
      ...(orgId ? { orgId } : {}),
    }) as unknown as Request

  it('returns 202 when under quota', async () => {
    const { handle } = getHandler('/me', 'post')
    const res = mockRes()
    await handle(makeReq(), res as unknown as Response)
    expect(res.statusCode).toBe(202)
  })

  it('returns 429 with Retry-After header when quota is exceeded', async () => {
    const { handle } = getHandler('/me', 'post')
    // Exhaust quota of 1 (patch env)
    const { getEnv } = await import('../config/index.js')
    const env = getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    const res1 = mockRes();
    await handle(makeReq('user-quota-x'), res1 as unknown as Response)
    expect(res1.statusCode).toBe(202)

    const res2 = mockRes()
    await handle(makeReq('user-quota-x'), res2 as unknown as Response)
    expect(res2.statusCode).toBe(429)
    expect(res2.headers['Retry-After']).toBeDefined()
    expect(Number(res2.headers['Retry-After'])).toBeGreaterThan(0)
    expect((res2.jsonBody as any).error).toMatch(/quota exceeded/i)
    expect((res2.jsonBody as any).retryAfter).toBeGreaterThan(0)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })

  it('ignores client-supplied orgId — quota is always scoped to req.user.userId', async () => {
    // SECURITY REGRESSION TEST for #1387
    // A caller must not be able to exhaust another org's quota or dodge their own
    // by supplying an arbitrary orgId via query param, header, or request body.
    const { handle } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    // Attacker request: claims to belong to 'victim-org' via every client-
    // controlled channel, but authenticates as 'attacker-user'.
    const attackerReq = {
      query: { format: 'json', scope: 'vaults', orgId: 'victim-org' },
      headers: { 'x-organization-id': 'victim-org' },
      user: { userId: 'attacker-user', role: 'USER' },
      // Also try setting it directly on the request object (old vulnerable path)
      orgId: 'victim-org',
      header: () => undefined,
    } as unknown as Request

    // First attacker request consumes attacker-user's own quota bucket
    const res1 = mockRes();
    await handle(attackerReq, res1 as unknown as Response)
    expect(res1.statusCode).toBe(202)

    // Attacker is now quota-limited (their userId bucket is exhausted)
    const res2 = mockRes()
    await handle(attackerReq, res2 as unknown as Response)
    expect(res2.statusCode).toBe(429)

    // Victim org's legitimate user is NOT affected — their userId bucket is untouched
    const victimReq = {
      query: { format: 'json', scope: 'vaults' },
      user: { userId: 'victim-org-user', role: 'USER' },
      header: () => undefined,
    } as unknown as Request

    const res3 = mockRes();
    await handle(victimReq, res3 as unknown as Response)
    expect(res3.statusCode).toBe(202)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })

  it('does not enqueue job when quota is exceeded', async () => {
    const { handle, jobSystem } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 0

    const res = mockRes();
    await handle(makeReq('user-no-enqueue'), res as unknown as Response)
    expect(res.statusCode).toBe(429)
    expect(jobSystem.enqueue).not.toHaveBeenCalled()

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })

  it('admits exactly N concurrent /me requests up to the quota', async () => {
    const { handle } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 3

    const results = await Promise.all(
      Array.from({ length: 10 }, () => {
        const res = mockRes()
        return handle(
          {
            query: { format: 'json', scope: 'vaults' },
            user: { userId: 'user-burst-route', role: 'USER' },
            header: () => undefined,
          } as unknown as Request,
          res as unknown as Response,
        ).then(() => res.statusCode)
      }),
    )

    expect(results.filter((code) => code === 202).length).toBe(3)
    expect(results.filter((code) => code === 429).length).toBe(7)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Route integration: POST /admin quota enforcement
// ══════════════════════════════════════════════════════════════════════════
describe('POST /admin quota enforcement', () => {
  it('returns 202 when under quota', async () => {
    const { handle } = getHandler('/admin', 'post')
    const res = mockRes();
    await handle(
      {
        query: { format: 'json', scope: 'all' },
        user: { userId: 'admin-1', role: 'ADMIN' },
        header: () => undefined,
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(202)
  })

  it('returns 429 when quota exceeded for admin', async () => {
    const { handle } = getHandler('/admin', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    const req = {
      query: { format: 'json', scope: 'all' },
      user: { userId: 'admin-quota', role: 'ADMIN' },
      header: () => undefined,
    } as unknown as Request

    const res1 = mockRes();
    await handle(req, res1 as unknown as Response)
    expect(res1.statusCode).toBe(202)

    const res2 = mockRes();
    await handle(req, res2 as unknown as Response)
    expect(res2.statusCode).toBe(429)
    expect(res2.headers['Retry-After']).toBeDefined()

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 5. Quota isolation: different users don't share quota
// ══════════════════════════════════════════════════════════════════════════
describe('Quota isolation between users', () => {
  it('each user has an independent quota when no orgId is set', async () => {
    const { handle } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    const req1 = {
      query: { format: 'json', scope: 'vaults' },
      user: { userId: 'iso-user-1', role: 'USER' },
      header: () => undefined,
    } as unknown as Request

    const req2 = {
      query: { format: 'json', scope: 'vaults' },
      user: { userId: 'iso-user-2', role: 'USER' },
      header: () => undefined,
    } as unknown as Request

    const res1a = mockRes();
    await handle(req1, res1a as unknown as Response)
    expect(res1a.statusCode).toBe(202)

    // user-1 exhausted, user-2 still allowed
    const res1b = mockRes();
    await handle(req1, res1b as unknown as Response)
    expect(res1b.statusCode).toBe(429)

    const res2a = mockRes();
    await handle(req2, res2a as unknown as Response)
    expect(res2a.statusCode).toBe(202)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})
