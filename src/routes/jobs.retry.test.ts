import express from 'express'
import request from 'supertest'
import { vi, describe, it, expect, beforeEach } from 'vitest'
import { createJobsRouter } from './jobs.js'
import type { BackgroundJobSystem } from '../jobs/system.js'

import { createAuditLog } from '../lib/audit-logs.js'
import type { RequestHandler } from 'express'

vi.mock('../lib/audit-logs.js', () => ({
  createAuditLog: vi.fn(),
}))

vi.mock('../middleware/auth.js', () => ({
  authenticate: vi.fn((req, res, next) => {
    const auth = req.headers.authorization
    if (!auth) return res.status(401).json({ error: 'Unauthenticated' })
    if (auth === 'Bearer admin-token') {
      req.user = { userId: 'test-admin', role: 'ADMIN' }
      return next()
    }
    if (auth === 'Bearer user-token') {
      req.user = { userId: 'test-user', role: 'USER' }
      return next()
    }
    return res.status(401).json({ error: 'Invalid token' })
  }),
  authorize: vi.fn((roles) => (req: any, res: any, next: any) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' })
    next()
  })
}))

const noopLimiter: RequestHandler = (_req, _res, next) => next()

const adminToken = 'admin-token'
const userToken = 'user-token'

const makeApp = (mockJobSystem: Partial<BackgroundJobSystem>) => {
  const app = express()
  app.use(express.json())
  app.use('/api/jobs', createJobsRouter(mockJobSystem as BackgroundJobSystem, { enqueueLimiter: noopLimiter }))
  return app
}

describe('POST /api/jobs/:id/retry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 with no token', async () => {
    const app = makeApp({})
    const res = await request(app).post('/api/jobs/123/retry')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin role', async () => {
    const app = makeApp({})
    const res = await request(app)
      .post('/api/jobs/123/retry')
      .set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(403)
  })

  it('returns 404 if job is not found', async () => {
    const mockJobSystem = {
      retryJob: vi.fn().mockImplementation(() => {
        throw new Error('Job not found or not in a failed state')
      }),
    }
    const app = makeApp(mockJobSystem)

    const res = await request(app)
      .post('/api/jobs/123/retry')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Job not found or not in a failed state')
    expect(mockJobSystem.retryJob).toHaveBeenCalledWith('123', false)
  })

  it('returns 400 if max_attempts is exhausted without force', async () => {
    const mockJobSystem = {
      retryJob: vi.fn().mockImplementation(() => {
        throw new Error('max_attempts is exhausted. Use ?force=true to retry anyway.')
      }),
    }
    const app = makeApp(mockJobSystem)

    const res = await request(app)
      .post('/api/jobs/123/retry')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
    expect(res.body.error).toBe('max_attempts is exhausted. Use ?force=true to retry anyway.')
    expect(mockJobSystem.retryJob).toHaveBeenCalledWith('123', false)
  })

  it('retries job successfully and records audit log', async () => {
    const mockReceipt = {
      id: '123',
      type: 'notification.send',
      runAt: new Date().toISOString(),
      maxAttempts: 3,
    }
    const mockJobSystem = {
      retryJob: vi.fn().mockReturnValue(mockReceipt),
    }
    const app = makeApp(mockJobSystem)

    const res = await request(app)
      .post('/api/jobs/123/retry')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ retried: true, job: mockReceipt })
    expect(mockJobSystem.retryJob).toHaveBeenCalledWith('123', false)
    
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'test-admin',
        action: 'job.retry',
        target_type: 'job',
        target_id: '123',
        metadata: {
          jobType: 'notification.send',
          forced: false,
        },
      })
    )
  })

  it('retries job successfully with force=true', async () => {
    const mockReceipt = {
      id: '123',
      type: 'notification.send',
      runAt: new Date().toISOString(),
      maxAttempts: 3,
    }
    const mockJobSystem = {
      retryJob: vi.fn().mockReturnValue(mockReceipt),
    }
    const app = makeApp(mockJobSystem)

    const res = await request(app)
      .post('/api/jobs/123/retry?force=true')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ retried: true, job: mockReceipt })
    expect(mockJobSystem.retryJob).toHaveBeenCalledWith('123', true)
    
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          jobType: 'notification.send',
          forced: true,
        },
      })
    )
  })
})
