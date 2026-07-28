import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals'
import type { Request, Response } from 'express'
import {
  createJob,
  processJob,
  resetExportJobs,
  getJob,
} from '../services/exportQueue.js'
import {
  resolveS3Config,
  setPresigner,
  resetPresigner,
} from '../services/exportS3.js'

const createAuditLogMock = jest.fn().mockResolvedValue({ id: 'audit-1' } as any)

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: createAuditLogMock,
}))

let createExportRouter: typeof import('../routes/exports.js').createExportRouter

type MockResponse = {
  status: (code: number) => MockResponse
  json: (body: unknown) => MockResponse
  setHeader: (name: string, value: string | number) => MockResponse
  send: (body: unknown) => MockResponse
  redirect: (code: number, url: string) => MockResponse
  statusCode?: number
  jsonBody?: unknown
  headers: Record<string, string | number>
  sentBody?: unknown
  redirectUrl?: string
}

const createMockResponse = (): MockResponse => {
  const r: MockResponse = {
    headers: {},
    status(code) { r.statusCode = code; return r },
    json(body) { r.jsonBody = body; return r },
    setHeader(name, value) { r.headers[name] = value; return r },
    send(body) { r.sentBody = body; return r },
    redirect(code, url) { r.statusCode = code; r.redirectUrl = url; return r },
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

describe('Export Download Authorization and Audit Logging', () => {
  beforeEach(async () => {
    jest.clearAllMocks()
    resetPresigner()
    await resetExportJobs()
    if (!createExportRouter) {
      createExportRouter = (await import('../routes/exports.js')).createExportRouter
    }
  })

  afterEach(async () => {
    await resetExportJobs()
    resetPresigner()
  })

  it('owner download succeeds and streams content when S3 is not configured', async () => {
    const job = await createJob({
      userId: 'user-owner',
      orgId: 'org-1',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-1',
    })

    await processJob(job.id, [
      { id: 'v-1', creator: 'user-owner', amount: '100', status: 'active', createdAt: '2026-01-01T00:00:00Z' },
    ])

    const { handle } = getHandler('/:id/download', 'get')
    const req = {
      params: { id: job.id },
      user: { userId: 'user-owner', role: 'USER' },
      orgId: 'org-1',
      headers: {},
      query: {},
    } as unknown as Request
    const res = createMockResponse()

    await handle(req, res as unknown as Response)

    expect(res.statusCode).toBeUndefined() // default 200 via express send
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.sentBody).toBeDefined()
    expect(createAuditLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'user-owner',
        action: 'export.download',
        target_id: job.id,
      }),
    )
  })

  it('rejects cross-org download attempts with HTTP 403', async () => {
    const job = await createJob({
      userId: 'user-owner',
      orgId: 'org-owner',
      isAdmin: false,
      scope: 'vaults',
      format: 'csv',
      maxAttempts: 3,
      requestHash: 'hash-2',
    })

    await processJob(job.id, [])

    const { handle } = getHandler('/:id/download', 'get')
    const req = {
      params: { id: job.id },
      user: { userId: 'user-attacker', role: 'USER' },
      orgId: 'org-attacker',
      headers: {},
      query: {},
    } as unknown as Request
    const res = createMockResponse()

    await handle(req, res as unknown as Response)

    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toEqual({ error: 'Forbidden: Cross-organization export download rejected' })
    expect(createAuditLogMock).not.toHaveBeenCalled()
  })

  it('returns HTTP 404 for unready, pending, or non-existent export jobs', async () => {
    const { handle } = getHandler('/:id/download', 'get')

    // Case 1: Non-existent job
    const reqNotFound = {
      params: { id: 'non-existent-id' },
      user: { userId: 'user-1', role: 'USER' },
      headers: {},
      query: {},
    } as unknown as Request
    const resNotFound = createMockResponse()
    await handle(reqNotFound, resNotFound as unknown as Response)
    expect(resNotFound.statusCode).toBe(404)

    // Case 2: Pending job
    const pendingJob = await createJob({
      userId: 'user-1',
      orgId: 'org-1',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-pending',
    })
    const reqPending = {
      params: { id: pendingJob.id },
      user: { userId: 'user-1', role: 'USER' },
      orgId: 'org-1',
      headers: {},
      query: {},
    } as unknown as Request
    const resPending = createMockResponse()
    await handle(reqPending, resPending as unknown as Response)
    expect(resPending.statusCode).toBe(404)
  })

  it('enforces short TTL for S3 signed URLs and handles redirect vs json responses', async () => {
    const mockPresign = jest.fn().mockResolvedValue('https://s3.amazonaws.com/bucket/key?signed=true')
    setPresigner(mockPresign as any)

    const origEnv = { ...process.env }
    process.env.EXPORT_S3_BUCKET = 'test-bucket'
    process.env.EXPORT_S3_REGION = 'us-east-1'

    const job = await createJob({
      userId: 'user-s3',
      orgId: 'org-s3',
      isAdmin: false,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-s3',
    })

    // Simulate done job with s3Key
    const { update } = await import('../services/exportQueue.js')
    await update({
      ...job,
      status: 'done',
      s3Key: `exports/${job.id}/export.json`,
    })

    const { handle } = getHandler('/:id/download', 'get')

    // Sub-test 1: JSON response requested via Accept header
    const reqJson = {
      params: { id: job.id },
      user: { userId: 'user-s3', role: 'USER' },
      orgId: 'org-s3',
      headers: { accept: 'application/json' },
      query: {},
    } as unknown as Request
    const resJson = createMockResponse()
    await handle(reqJson, resJson as unknown as Response)

    expect(resJson.jsonBody).toEqual({
      downloadUrl: 'https://s3.amazonaws.com/bucket/key?signed=true',
      expiresInSeconds: 60,
    })
    expect(mockPresign).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 60 },
    )

    // Sub-test 2: Default redirect
    const reqRedirect = {
      params: { id: job.id },
      user: { userId: 'user-s3', role: 'USER' },
      orgId: 'org-s3',
      headers: {},
      query: {},
    } as unknown as Request
    const resRedirect = createMockResponse()
    await handle(reqRedirect, resRedirect as unknown as Response)

    expect(resRedirect.statusCode).toBe(302)
    expect(resRedirect.redirectUrl).toBe('https://s3.amazonaws.com/bucket/key?signed=true')

    process.env = origEnv
  })
})
