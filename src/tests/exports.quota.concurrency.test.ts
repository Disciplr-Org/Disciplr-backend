import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { Request, Response } from 'express'
import {
  EXPORT_QUOTA_METRIC,
  getOrgQuotaEntry,
  resetOrgQuotas,
  utcDateString,
} from '../services/exportQuota.js'
import { resetExportJobs } from '../services/exportQueue.js'

const testEnv = {
  EXPORT_DAILY_QUOTA_LIMIT: 100,
}

jest.unstable_mockModule('../config/index.js', () => ({
  getEnv: () => testEnv,
  initEnv: () => ({ env: testEnv, warnings: [] }),
  _resetEnvForTesting: () => undefined,
}))

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: () => void) => next(),
  requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
  signDownloadToken: () => 'mock-token',
  verifyDownloadToken: () => null,
}))

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
    status(code) {
      r.statusCode = code
      return r
    },
    json(body) {
      r.jsonBody = body
      return r
    },
    setHeader(name, value) {
      r.headers[name] = value
      return r
    },
    send(body) {
      void body
      return r
    },
  }
  return r
}

const createMockJobSystem = () => ({
  enqueue: jest.fn(() => ({
    id: `job-${Math.random().toString(16).slice(2)}`,
    type: 'export.generate',
    runAt: new Date().toISOString(),
    maxAttempts: 3,
  })),
})

let createExportRouter: typeof import('../routes/exports.js').createExportRouter

type RouteLayer = {
  route?: {
    path?: string
    methods?: Partial<Record<'post' | 'get', boolean>>
    stack?: Array<{ handle: unknown }>
  }
}

const getHandler = (path: string, method: 'post' | 'get', jobSystem = createMockJobSystem()) => {
  const router = createExportRouter(jobSystem as never)
  const stack = router.stack as unknown as RouteLayer[]
  const layer = stack.find((e) => e.route?.path === path && Boolean(e.route?.methods?.[method]))
  if (!layer?.route?.stack?.length) throw new Error(`Handler not found: ${method.toUpperCase()} ${path}`)
  return {
    jobSystem,
    handle: layer.route.stack[layer.route.stack.length - 1].handle as (
      req: Request,
      res: Response,
    ) => Promise<void>,
  }
}

const makeReq = (orgId: string, userId = 'quota-burst-user') =>
  ({
    query: { format: 'json', scope: 'vaults' },
    user: { userId, role: 'USER' },
    orgId,
    header: () => undefined,
  }) as unknown as Request

const withQuotaLimit = async (limit: number, fn: () => Promise<void>): Promise<void> => {
  const original = testEnv.EXPORT_DAILY_QUOTA_LIMIT
  testEnv.EXPORT_DAILY_QUOTA_LIMIT = limit
  try {
    await fn()
  } finally {
    testEnv.EXPORT_DAILY_QUOTA_LIMIT = original
  }
}

const runBurst = async (orgId: string, burstSize: number) => {
  const { handle, jobSystem } = getHandler('/me', 'post')
  const responses = Array.from({ length: burstSize }, () => mockRes())

  await Promise.all(
    responses.map((res, index) =>
      handle(makeReq(orgId, `quota-burst-user-${index}`), res as unknown as Response),
    ),
  )

  return { responses, jobSystem }
}

beforeEach(async () => {
  testEnv.EXPORT_DAILY_QUOTA_LIMIT = 100
  if (!createExportRouter) {
    createExportRouter = (await import('../routes/exports.js')).createExportRouter
  }
  await resetOrgQuotas()
  await resetExportJobs()
  jest.restoreAllMocks()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('export quota concurrency', () => {
  it('accepts exactly K concurrent exports and rejects the rest with 429 without over-counting', async () => {
    await withQuotaLimit(3, async () => {
      const orgId = 'org-concurrent-burst'
      const { responses, jobSystem } = await runBurst(orgId, 10)

      const accepted = responses.filter((res) => res.statusCode === 202)
      const rejected = responses.filter((res) => res.statusCode === 429)

      expect(accepted).toHaveLength(3)
      expect(rejected).toHaveLength(7)
      expect(jobSystem.enqueue).toHaveBeenCalledTimes(3)

      for (const res of rejected) {
        expect(res.headers['Retry-After']).toBeDefined()
        expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0)
        expect((res.jsonBody as { error?: string }).error).toMatch(/quota exceeded/i)
        expect((res.jsonBody as { retryAfter?: number }).retryAfter).toBeGreaterThan(0)
      }

      const quota = await getOrgQuotaEntry(orgId, utcDateString(), EXPORT_QUOTA_METRIC)
      expect(quota?.count).toBe(3)
      expect(quota?.limit).toBe(3)
    })
  })

  it('refreshes the quota budget when the UTC quota date changes', async () => {
    jest.useFakeTimers()

    await withQuotaLimit(2, async () => {
      jest.setSystemTime(new Date('2030-06-15T23:59:50.000Z'))
      const orgId = 'org-concurrent-reset-window'

      const firstWindow = await runBurst(orgId, 5)
      expect(firstWindow.responses.filter((res) => res.statusCode === 202)).toHaveLength(2)
      expect(firstWindow.responses.filter((res) => res.statusCode === 429)).toHaveLength(3)
      expect((await getOrgQuotaEntry(orgId, '2030-06-15', EXPORT_QUOTA_METRIC))?.count).toBe(2)

      jest.setSystemTime(new Date('2030-06-16T00:00:01.000Z'))
      const secondWindow = await runBurst(orgId, 2)
      expect(secondWindow.responses.filter((res) => res.statusCode === 202)).toHaveLength(2)
      expect(secondWindow.responses.filter((res) => res.statusCode === 429)).toHaveLength(0)
      expect((await getOrgQuotaEntry(orgId, '2030-06-16', EXPORT_QUOTA_METRIC))?.count).toBe(2)
    })
  })
})
