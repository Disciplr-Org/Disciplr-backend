import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals'
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import {
  createJob,
  getJob,
  processJob,
  recoverPendingExportJobs,
  resetExportJobs,
  serializeExportData,
} from '../services/exportQueue.js'

const buildDownloadToken = (jobId: string, userId: string, ttlSeconds = 3600): string => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${jobId}:${userId}:${exp}`
  const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return Buffer.from(JSON.stringify({ jobId, userId, exp, sig })).toString('base64url')
}

const signDownloadTokenMock = jest.fn(buildDownloadToken)

jest.unstable_mockModule('../middleware/auth.js', () => ({
  authenticate: (_req: Request, _res: Response, next: () => void) => next(),
  requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
  signDownloadToken: signDownloadTokenMock,
  verifyDownloadToken: (token: string) => {
    try {
      const { jobId, userId, exp, sig } = JSON.parse(
        Buffer.from(token, 'base64url').toString('utf8'),
      ) as { jobId: string; userId: string; exp: number; sig: string }
      const payload = `${jobId}:${userId}:${exp}`
      const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
      const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')

      if (Date.now() / 1000 > exp || sig !== expected) {
        return null
      }

      return { jobId, userId }
    } catch {
      return null
    }
  },
}))

let createExportRouter: typeof import('./exports.js').createExportRouter

type MockResponse = {
  status: (statusCode: number) => MockResponse
  json: (body: unknown) => MockResponse
  setHeader: (name: string, value: string | number) => MockResponse
  send: (body: unknown) => MockResponse
  statusCode?: number
  jsonBody?: unknown
  headers: Record<string, string | number>
  sentBody?: unknown
}

const createMockResponse = (): MockResponse => {
  const response: MockResponse = {
    headers: {},
    status(statusCode: number) {
      response.statusCode = statusCode
      return response
    },
    json(body: unknown) {
      response.jsonBody = body
      return response
    },
    setHeader(name: string, value: string | number) {
      response.headers[name] = value
      return response
    },
    send(body: unknown) {
      response.sentBody = body
      return response
    },
  }

  return response
}

const createMockJobSystem = () => ({
  enqueue: jest.fn(() => ({
    id: crypto.randomUUID(),
    type: 'export.generate',
    runAt: new Date().toISOString(),
    maxAttempts: 3,
  })),
})

const getRouteHandler = (
  path: string,
  method: 'post' | 'get',
  jobSystem = createMockJobSystem(),
) => {
  const router = createExportRouter(jobSystem as never)
  const layer = router.stack.find(
    (entry) => (entry.route as { path?: string; methods?: Record<string, boolean> } | undefined)?.path === path
      && Boolean((entry.route as { methods?: Record<string, boolean> } | undefined)?.methods?.[method]),
  )

  if (!layer?.route?.stack?.length) {
    throw new Error(`Route handler not found for ${method.toUpperCase()} ${path}`)
  }

  return {
    jobSystem,
    handle: layer.route.stack[layer.route.stack.length - 1].handle as (
      req: Request,
      res: Response,
    ) => Promise<void> | void,
  }
}

describe('Export routes and CSV behavior', () => {
  beforeEach(async () => {
    if (!createExportRouter) {
      createExportRouter = (await import('./exports.js')).createExportRouter
    }
  })

  beforeEach(async () => {
    await resetExportJobs()
    signDownloadTokenMock.mockClear()
    jest.restoreAllMocks()
  })

  afterAll(async () => {
    await resetExportJobs()
  })

  it('serializes CSV exports with stable ordering, escaping, and formula mitigation', () => {
    const { buffer } = serializeExportData(
      {
        vaults: [
          {
            id: 'vault-1',
            creator: '=malicious',
            amount: '150.25',
            status: 'active',
            startDate: '2030-01-01T00:00:00.000Z',
            endDate: '2030-02-01T00:00:00.000Z',
            verifier: '@reviewer',
            successDestination: 'G-DEST-1',
            failureDestination: 'G-FAIL-1',
            createdAt: '2030-01-01T12:00:00.000Z',
          },
        ],
        transactions: [
          {
            id: 'txn-1',
            userId: 'user-1',
            vaultId: 'vault-1',
            txHash: 'hash-1',
            type: 'creation',
            amount: '150.25',
            assetCode: 'XLM',
            fromAccount: 'from-account',
            toAccount: 'to-account',
            memo: 'hello, "csv"',
            stellarLedger: 123,
            stellarTimestamp: '2030-01-02T00:00:00.000Z',
            explorerUrl: 'https://example.test/tx/hash-1',
            createdAt: '2030-01-02T00:00:00.000Z',
          },
        ],
        analytics: [
          {
            userId: 'user-1',
            totalVaults: 1,
            activeVaults: 1,
            completedVaults: 0,
            totalAmount: 150.25,
            exportedAt: '2030-01-03T00:00:00.000Z',
          },
        ],
      },
      'csv',
    )

    const csv = buffer.toString('utf8')

    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(csv.indexOf('# VAULTS')).toBeLessThan(csv.indexOf('# TRANSACTIONS'))
    expect(csv.indexOf('# TRANSACTIONS')).toBeLessThan(csv.indexOf('# ANALYTICS'))
    expect(csv).toContain("'=malicious")
    expect(csv).toContain("'@reviewer")
    expect(csv).toContain('"hello, ""csv"""')
    expect(csv).toContain('id,creator,amount,status,startDate,endDate,verifier,successDestination,failureDestination,createdAt')
  })

  it('emits CSV headers even when a dataset is empty', () => {
    const { buffer } = serializeExportData({ vaults: [] }, 'csv')
    const csv = buffer.toString('utf8')

    expect(csv).toContain('# VAULTS')
    expect(csv).toContain('id,creator,amount,status,startDate,endDate,verifier,successDestination,failureDestination,createdAt')
  })

  it('enqueues export requests idempotently and returns the same job on retry', async () => {
    const { handle, jobSystem } = getRouteHandler('/me', 'post')
    const makeRequest = () =>
      ({
        query: { format: 'csv', scope: 'vaults' },
        user: { userId: 'user-7', role: 'USER' },
        header: (name: string) => (name === 'idempotency-key' ? 'same-key' : undefined),
      }) as unknown as Request

    const firstResponse = createMockResponse()
    const secondResponse = createMockResponse()

    await handle(makeRequest(), firstResponse as unknown as Response)
    await handle(makeRequest(), secondResponse as unknown as Response)

    expect(firstResponse.statusCode).toBe(202)
    expect(secondResponse.statusCode).toBe(202)
    expect((firstResponse.jsonBody as { jobId: string }).jobId).toBe(
      (secondResponse.jsonBody as { jobId: string }).jobId,
    )
    expect(jobSystem.enqueue).toHaveBeenCalledTimes(1)
  })

  it('prevents non-admin users from reading another user status', async () => {
    const job = await createJob({
      userId: 'owner-user',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-owner',
    })

    const { handle } = getRouteHandler('/status/:jobId', 'get')
    const response = createMockResponse()

    await handle(
      {
        params: { jobId: job.id },
        user: { userId: 'other-user', role: 'USER' },
      } as unknown as Request,
      response as unknown as Response,
    )

    expect(response.statusCode).toBe(403)
    expect(response.jsonBody).toEqual({ error: 'Access denied' })
  })

  it('recovers pending jobs after a worker restart by re-enqueueing them', async () => {
    const jobSystem = createMockJobSystem()
    const job = await createJob({
      userId: 'user-8',
      isAdmin: false,
      scope: 'transactions',
      format: 'json',
      maxAttempts: 4,
      requestHash: 'hash-recovery',
    })

    const recoveredCount = await recoverPendingExportJobs(jobSystem as never)

    expect(recoveredCount).toBe(1)
    expect((jobSystem.enqueue as jest.Mock)).toHaveBeenCalledWith(
      'export.generate',
      { exportJobId: job.id },
      { maxAttempts: 4 },
    )
  })

  it('serves CSV downloads with explicit UTF-8 headers after processing', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const job = await createJob({
      userId: 'user-4',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-download',
    })

    await processJob(job.id, [
      {
        id: 'vault-4',
        creator: 'user-4',
        amount: '300',
        createdAt: '2030-04-10T00:00:00.000Z',
        status: 'completed',
      },
    ])

    const completedJob = await getJob(job.id)
    const { handle } = getRouteHandler('/download/:token', 'get')
    const token = signDownloadTokenMock(job.id, 'user-4', 3600) as string
    const response = createMockResponse()

    await handle(
      { params: { token } } as unknown as Request,
      response as unknown as Response,
    )

    expect(completedJob?.status).toBe('done')
    expect(response.statusCode).toBeUndefined()
    expect(response.headers['Content-Type']).toBe('text/csv; charset=utf-8')
    expect(String(response.headers['Content-Disposition'])).toContain('.csv"')
    expect(response.headers['Content-Length']).toBe((completedJob?.result as Buffer).length)
    expect((response.sentBody as Buffer).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

    const logEntries = infoSpy.mock.calls.map(([entry]) => String(entry))
    expect(logEntries.some((entry) => entry.includes('"event":"exports.download_served"'))).toBe(true)
    expect(logEntries.some((entry) => entry.includes('user-4'))).toBe(false)
  })

  it('stores completed CSV jobs without leaking user identifiers into structured logs', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)
    const job = await createJob({
      userId: 'user-3',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-complete',
    })

    await processJob(job.id, [
      {
        id: 'vault-3',
        creator: 'user-3',
        amount: '99',
        createdAt: '2030-03-01T00:00:00.000Z',
        status: 'active',
      },
    ])

    const completedJob = await getJob(job.id)
    expect(completedJob?.status).toBe('done')
    expect(completedJob?.result?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

    const logEntries = infoSpy.mock.calls.map(([entry]) => String(entry))
    expect(logEntries.some((entry) => entry.includes('"event":"exports.job_completed"'))).toBe(true)
    expect(logEntries.some((entry) => entry.includes('"format":"csv"'))).toBe(true)
    expect(logEntries.some((entry) => entry.includes('user-3'))).toBe(false)
  })
})
