import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { Request, Response } from 'express'
import {
  checkAndIncrementExportQuota,
  configureOrgQuotaRepository,
  resetOrgQuotas,
  utcDateString,
  EXPORT_QUOTA_METRIC,
} from '../services/exportQuota.js'
import { resetExportJobs } from '../services/exportQueue.js'
import { initEnv, _resetEnvForTesting } from '../config/index.js'

// ── auth mock ──────────────────────────────────────────────────────────────
jest.unstable_mockModule('../middleware/auth.js', () => ({
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
  if (!layer?.route?.stack?.length) throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`)
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
    const customRepo = {
      increment: jest.fn(async () => ({
        orgId: 'x',
        quotaDate: utcDateString(),
        metric: EXPORT_QUOTA_METRIC,
        count: ++count,
        limit: 10,
        updatedAt: new Date().toISOString(),
      })),
      get: jest.fn(async () => undefined),
      reset: jest.fn(async () => undefined),
    }

    configureOrgQuotaRepository(customRepo)
    const result = await checkAndIncrementExportQuota('x', 10)
    expect(result.allowed).toBe(true)
    expect(customRepo.increment).toHaveBeenCalledTimes(1)

    // Restore default in-memory repo
    configureOrgQuotaRepository({
      increment: async (orgId, date, metric, dailyLimit) => {
        await resetOrgQuotas()
        const r = await checkAndIncrementExportQuota(orgId, dailyLimit)
        void r
        return { orgId, quotaDate: date, metric, count: 1, limit: dailyLimit, updatedAt: new Date().toISOString() }
      },
      get: async () => undefined,
      reset: async () => undefined,
    })
    // Reset to fresh in-memory repo after this test
    const { configureOrgQuotaRepository: restore } = await import('../services/exportQuota.js')
    // Re-import will reuse module cache; just reset quotas
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
// 2. Route integration: POST /me quota enforcement
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

    const res1 = mockRes()
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

  it('uses orgId from request when present', async () => {
    const { handle } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 1

    // First request via org-shared scopes the quota to the orgId
    const reqWithOrg = {
      query: { format: 'json', scope: 'vaults' },
      user: { userId: 'user-a', role: 'USER' },
      header: () => undefined,
      orgId: 'shared-org',
    } as unknown as Request

    const res1 = mockRes()
    await handle(reqWithOrg, res1 as unknown as Response)
    expect(res1.statusCode).toBe(202)

    // Second request for same org is blocked
    const res2 = mockRes()
    await handle(reqWithOrg, res2 as unknown as Response)
    expect(res2.statusCode).toBe(429)

    // Different user, different org — not blocked
    const reqOtherOrg = {
      query: { format: 'json', scope: 'vaults' },
      user: { userId: 'user-b', role: 'USER' },
      header: () => undefined,
      orgId: 'other-org',
    } as unknown as Request

    const res3 = mockRes()
    await handle(reqOtherOrg, res3 as unknown as Response)
    expect(res3.statusCode).toBe(202)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })

  it('does not enqueue job when quota is exceeded', async () => {
    const { handle, jobSystem } = getHandler('/me', 'post')
    const env = (await import('../config/index.js')).getEnv()
    const original = env.EXPORT_DAILY_QUOTA_LIMIT
    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = 0

    const res = mockRes()
    await handle(makeReq('user-no-enqueue'), res as unknown as Response)
    expect(res.statusCode).toBe(429)
    expect(jobSystem.enqueue).not.toHaveBeenCalled()

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 3. Route integration: POST /admin quota enforcement
// ══════════════════════════════════════════════════════════════════════════
describe('POST /admin quota enforcement', () => {
  it('returns 202 when under quota', async () => {
    const { handle } = getHandler('/admin', 'post')
    const res = mockRes()
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

    const res1 = mockRes()
    await handle(req, res1 as unknown as Response)
    expect(res1.statusCode).toBe(202)

    const res2 = mockRes()
    await handle(req, res2 as unknown as Response)
    expect(res2.statusCode).toBe(429)
    expect(res2.headers['Retry-After']).toBeDefined()

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})

// ══════════════════════════════════════════════════════════════════════════
// 4. Quota isolation: different users don't share quota
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

    const res1a = mockRes()
    await handle(req1, res1a as unknown as Response)
    expect(res1a.statusCode).toBe(202)

    // user-1 exhausted, user-2 still allowed
    const res1b = mockRes()
    await handle(req1, res1b as unknown as Response)
    expect(res1b.statusCode).toBe(429)

    const res2a = mockRes()
    await handle(req2, res2a as unknown as Response)
    expect(res2a.statusCode).toBe(202)

    ;(env as any).EXPORT_DAILY_QUOTA_LIMIT = original
  })
})
