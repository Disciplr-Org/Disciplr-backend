import crypto, { randomUUID } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { describe, expect, it, beforeEach, afterAll, jest } from '@jest/globals'
import type { Request, Response } from 'express'
import {
  createJob,
  getJob,
  processJob,
  recoverPendingExportJobs,
  resetExportJobs,
  resetDlq,
  getDlqDepth,
  serializeExportData,
} from '../services/exportQueue.js'
import { setOrgMembers } from '../models/organizations.js'
import { setAuditLogWriterForTests } from '../lib/audit-logs.js'
import { initEnv, _resetEnvForTesting } from '../config/index.js'

// Connection to this address is refused immediately and deterministically,
// which makes the export data-fetch path fail fast in retry/failure tests.
process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://user:pass@127.0.0.1:1/db'

// ── download-token helper (shared by the auth mock and tests) ─────────────
const buildDownloadToken = (jobId: string, userId: string, ttlSeconds = 3600): string => {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds
  const payload = `${jobId}:${userId}:${exp}`
  const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')
  return Buffer.from(JSON.stringify({ jobId, userId, exp, sig })).toString('base64url')
}

// The module factory may only reference variables prefixed with `mock` plus
// `jest` APIs, so the token signer is exposed through a mock-prefixed handle.
const mockSignDownloadToken = jest.fn(buildDownloadToken)

jest.mock('../middleware/auth.js', () => {
  const cryptoMod = jest.requireActual<typeof import('node:crypto')>('node:crypto')
  return {
    authenticate: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
    signDownloadToken: mockSignDownloadToken,
    verifyDownloadToken: (token: string) => {
      try {
        const { jobId, userId, exp, sig } = JSON.parse(
          Buffer.from(token, 'base64url').toString('utf8'),
        ) as { jobId: string; userId: string; exp: number; sig: string }
        const payload = `${jobId}:${userId}:${exp}`
        const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
        const expected = cryptoMod.createHmac('sha256', secret).update(payload).digest('hex')

        if (Date.now() / 1000 > exp || sig !== expected) {
          return null
        }

        return { jobId, userId }
      } catch {
        return null
      }
    },
  }
})

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
    id: randomUUID(),
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
    _resetEnvForTesting()
    initEnv()
    await resetExportJobs()
    await resetDlq()
    mockSignDownloadToken.mockClear()
    jest.restoreAllMocks()
    setOrgMembers([])
    // Keep audit logging out of the DB in these route tests; the route wraps
    // the call in try/catch anyway, but a deterministic no-op writer keeps
    // output clean and makes download authorization tests hermetic.
    setAuditLogWriterForTests(async (entry: any) => ({
      id: 'audit-test',
      created_at: new Date().toISOString(),
      ...entry,
    }))
  })

  afterAll(async () => {
    await resetExportJobs()
    setAuditLogWriterForTests(null)
  })

  // ── serialization contract ───────────────────────────────────────────────
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

  it('emits a valid empty CSV (BOM only, no fabricated rows) when a dataset is empty', () => {
    // Matches the streaming serializer contract: an empty export is a valid
    // empty document, not a fabricated header row. See STREAMING_EXPORT_DESIGN.md.
    const { buffer } = serializeExportData({ vaults: [] }, 'csv')
    const csv = buffer.toString('utf8')

    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    expect(csv).not.toContain('# VAULTS')
    expect(csv).not.toContain('creator')
  })

  it('serializes an empty JSON dataset as a valid empty section object', () => {
    const { buffer, filename } = serializeExportData({ vaults: [] }, 'json')
    expect(filename).toMatch(/\.json$/)
    expect(JSON.parse(buffer.toString('utf8'))).toEqual({ vaults: [] })
  })

  it('serializes an empty NDJSON dataset to an empty buffer with an .ndjson filename', () => {
    const { buffer, filename } = serializeExportData({ vaults: [] }, 'ndjson')
    expect(filename).toMatch(/\.ndjson$/)
    expect(buffer.length).toBe(0)
  })

  // ── enqueue contract ─────────────────────────────────────────────────────
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

  it('returns 409 when the same idempotency key is reused with a different request shape', async () => {
    const { handle } = getRouteHandler('/me', 'post')
    const makeRequest = (scope: string) =>
      ({
        query: { format: 'csv', scope },
        user: { userId: 'user-11', role: 'USER' },
        header: (name: string) => (name === 'idempotency-key' ? 'conflict-key' : undefined),
      }) as unknown as Request

    const firstResponse = createMockResponse()
    await handle(makeRequest('vaults'), firstResponse as unknown as Response)
    expect(firstResponse.statusCode).toBe(202)

    const secondResponse = createMockResponse()
    await handle(makeRequest('transactions'), secondResponse as unknown as Response)
    expect(secondResponse.statusCode).toBe(409)
    expect((secondResponse.jsonBody as { error?: string }).error).toMatch(/idempotency/i)
  })

  it('returns 400 for an invalid scope before any quota or job side effects', async () => {
    const { handle, jobSystem } = getRouteHandler('/me', 'post')
    const res = createMockResponse()
    await handle(
      {
        query: { format: 'csv', scope: 'bogus' },
        user: { userId: 'user-400', role: 'USER' },
        header: () => undefined,
      } as unknown as Request,
      res as unknown as Response,
    )

    expect(res.statusCode).toBe(400)
    expect(jobSystem.enqueue).not.toHaveBeenCalled()
  })

  it('returns 400 for a column allowlist that references an unknown section', async () => {
    const { handle } = getRouteHandler('/me', 'post')
    const res = createMockResponse()
    await handle(
      {
        query: { format: 'csv', scope: 'vaults', columns: JSON.stringify({ nope: ['id'] }) },
        user: { userId: 'user-400b', role: 'USER' },
        header: () => undefined,
      } as unknown as Request,
      res as unknown as Response,
    )

    expect(res.statusCode).toBe(400)
  })

  // ── status contract (loading / failure / permission) ─────────────────────
  it('exposes the loading shape for a pending job without a downloadUrl', async () => {
    const job = await createJob({
      userId: 'user-loading',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-loading',
    })

    const { handle } = getRouteHandler('/status/:jobId', 'get')
    const res = createMockResponse()

    await handle(
      {
        params: { jobId: job.id },
        user: { userId: 'user-loading', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )

    // Non-terminal status responses are sent via res.json with Express's
    // implicit 200; the mock exposes the body without an explicit status call.
    expect(res.jsonBody).toMatchObject({
      jobId: job.id,
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
    })
    expect((res.jsonBody as { downloadUrl?: string }).downloadUrl).toBeUndefined()
  })

  it('returns 404 for an unknown status job', async () => {
    const { handle } = getRouteHandler('/status/:jobId', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { jobId: 'does-not-exist' },
        user: { userId: 'user-404', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(404)
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

  it('allows admins to read any user job status', async () => {
    const job = await createJob({
      userId: 'other-user',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-admin-read',
    })

    const { handle } = getRouteHandler('/status/:jobId', 'get')
    const response = createMockResponse()

    await handle(
      {
        params: { jobId: job.id },
        user: { userId: 'admin-1', role: 'ADMIN' },
      } as unknown as Request,
      response as unknown as Response,
    )

    expect((response.jsonBody as { status?: string }).status).toBe('pending')
  })

  // ── retry / failure contract ─────────────────────────────────────────────
  it('retries a failed data-fetch attempt and completes on the next attempt', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const job = await createJob({
      userId: 'user-retry',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-retry',
    })

    // No vaultsStore is passed, so the data-fetch layer hits the (unreachable)
    // database adapter and fails — the retryable failure path.
    await expect(processJob(job.id)).rejects.toThrow()

    const retryable = await getJob(job.id)
    expect(retryable?.status).toBe('pending')
    expect(retryable?.attempts).toBe(1)
    expect(retryable?.error).toBeDefined()
    expect(await getDlqDepth()).toBe(0)

    // Second attempt succeeds with an in-memory vault store
    await processJob(job.id, [
      { id: 'v1', creator: 'user-retry', amount: '1', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])
    const done = await getJob(job.id)
    expect(done?.status).toBe('done')
    expect(done?.attempts).toBe(2)

    errorSpy.mockRestore()
  })

  it('marks a job permanently failed, surfaces the error on status, and moves it to the DLQ', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const job = await createJob({
      userId: 'user-fail',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 1,
      requestHash: 'hash-fail',
    })

    await expect(processJob(job.id)).rejects.toThrow()

    const failed = await getJob(job.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBeDefined()
    expect(await getDlqDepth()).toBe(1)

    const { handle } = getRouteHandler('/status/:jobId', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { jobId: job.id },
        user: { userId: 'user-fail', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect((res.jsonBody as { status?: string }).status).toBe('failed')
    expect((res.jsonBody as { error?: string }).error).toBeDefined()

    errorSpy.mockRestore()
  })

  // ── download contract (format / permission) ──────────────────────────────
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
    const token = mockSignDownloadToken(job.id, 'user-4', 3600) as string
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

  it('completes local NDJSON exports with a downloadable plain-NDJSON buffer', async () => {
    // REGRESSION: an ndjson export with no S3 configured used to complete with
    // status 'done' but no result bytes, so every download returned 404.
    const job = await createJob({
      userId: 'user-ndjson',
      isAdmin: false,
      scope: 'vaults',
      format: 'ndjson',
      maxAttempts: 3,
      requestHash: 'hash-ndjson-local',
    })

    await processJob(job.id, [
      { id: 'vault-9', creator: 'user-ndjson', amount: '42', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])

    const done = await getJob(job.id)
    expect(done?.status).toBe('done')
    expect(done?.result).toBeDefined()
    expect(done?.filename).toMatch(/\.ndjson$/)

    const text = done!.result!.toString('utf8')
    expect(text).toContain('"id":"vault-9"')
    // Plain NDJSON locally — not gzip-compressed
    expect(text.startsWith('\u001f\u008b')).toBe(false)

    // And the authenticated download endpoint actually serves it
    const { handle } = getRouteHandler('/:id/download', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { id: job.id },
        user: { userId: 'user-ndjson', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBeUndefined()
    expect(res.headers['Content-Type']).toBe('application/x-ndjson')
    expect((res.sentBody as Buffer).toString('utf8')).toContain('"id":"vault-9"')
  })

  it('rejects cross-organization downloads with 403', async () => {
    setOrgMembers([])
    const job = await createJob({
      userId: 'owner-org-user',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-xorg',
    })
    await processJob(job.id, [
      { id: 'v1', creator: 'owner-org-user', amount: '1', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])

    const { handle } = getRouteHandler('/:id/download', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { id: job.id },
        user: { userId: 'other-user', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBe(403)
    expect((res.jsonBody as { error?: string }).error).toMatch(/cross-organization/i)
  })

  it('allows an organization member to download an org-scoped export', async () => {
    setOrgMembers([{ orgId: 'org-shared', userId: 'member-user', role: 'member' }])
    const job = await createJob({
      userId: 'admin-owner',
      orgId: 'org-shared',
      isAdmin: true,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-org-member',
    })
    await processJob(job.id, [
      { id: 'v1', creator: 'admin-owner', amount: '1', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])

    const { handle } = getRouteHandler('/:id/download', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { id: job.id },
        user: { userId: 'member-user', role: 'USER' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBeUndefined()
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('allows an admin to download another user export regardless of membership', async () => {
    setOrgMembers([])
    const job = await createJob({
      userId: 'owner-user',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-admin-download',
    })
    await processJob(job.id, [
      { id: 'v1', creator: 'owner-user', amount: '1', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])

    const { handle } = getRouteHandler('/:id/download', 'get')
    const res = createMockResponse()
    await handle(
      {
        params: { id: job.id },
        user: { userId: 'admin-1', role: 'ADMIN' },
      } as unknown as Request,
      res as unknown as Response,
    )
    expect(res.statusCode).toBeUndefined()
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
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
