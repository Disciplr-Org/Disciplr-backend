import express from 'express'
import request from 'supertest'
import { createJobsRouter } from './jobs.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import type { QueueMetrics } from '../jobs/queue.js'
import { generateAccessToken } from '../lib/auth-utils.js'
import type { RequestHandler } from 'express'

// No-op rate limiter so tests aren't throttled
const noopLimiter: RequestHandler = (_req, _res, next) => next()

const adminToken = generateAccessToken({ userId: 'test-admin', role: 'ADMIN' })
const userToken = generateAccessToken({ userId: 'test-user', role: 'USER' })

const baseMetrics: QueueMetrics = {
  running: true,
  concurrency: 2,
  pollIntervalMs: 250,
  uptimeMs: 1000,
  queueDepth: 0,
  delayedJobs: 0,
  activeJobs: 0,
  deadLetterJobs: 0,
  totals: { enqueued: 0, executions: 0, completed: 0, failed: 0, retried: 0 },
  byType: {
    'notification.send': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'deadline.check': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'oracle.call': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
    'analytics.recompute': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0 },
  },
  recentFailures: [],
}

const makeApp = (metrics: Partial<QueueMetrics>) => {
  const merged: QueueMetrics = {
    ...baseMetrics,
    ...metrics,
    totals: { ...baseMetrics.totals, ...(metrics.totals ?? {}) },
  }
  const mockJobSystem = { getMetrics: () => merged } as unknown as BackgroundJobSystem
  const app = express()
  app.use(express.json())
  app.use('/api/jobs', createJobsRouter(mockJobSystem, { enqueueLimiter: noopLimiter }))
  return app
}

describe('GET /api/jobs/health — auth', () => {
  const app = makeApp({})

  it('returns 401 with no token', async () => {
    const res = await request(app).get('/api/jobs/health')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin role', async () => {
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(403)
  })
})

describe('GET /api/jobs/health — status thresholds', () => {
  it('returns ok when running and failureRate = 0 (zero executions)', async () => {
    const app = makeApp({ running: true, totals: { enqueued: 0, executions: 0, completed: 0, failed: 0, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.queue.failureRate).toBe(0)
    expect(res.body.queue.running).toBe(true)
  })

  it('returns ok when running and failureRate exactly 0.25 (boundary)', async () => {
    // 1 failed out of 4 = 0.25, which is NOT > 0.25, so still ok
    const app = makeApp({ running: true, totals: { enqueued: 4, executions: 4, completed: 3, failed: 1, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.queue.failureRate).toBe(0.25)
  })

  it('returns degraded when running and failureRate > 0.25', async () => {
    // 2 failed out of 5 = 0.4
    const app = makeApp({ running: true, totals: { enqueued: 5, executions: 5, completed: 3, failed: 2, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('degraded')
    expect(res.body.queue.failureRate).toBeCloseTo(0.4)
    expect(res.body.queue.running).toBe(true)
  })

  it('returns down with 503 when running = false', async () => {
    const app = makeApp({ running: false, totals: { enqueued: 0, executions: 0, completed: 0, failed: 0, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('down')
    expect(res.body.queue.running).toBe(false)
  })

  it('returns down (not degraded) when running = false even with high failure rate', async () => {
    // running=false takes precedence over failure rate
    const app = makeApp({ running: false, totals: { enqueued: 5, executions: 5, completed: 0, failed: 5, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(503)
    expect(res.body.status).toBe('down')
  })

  it('returns ok when running and all jobs succeeded', async () => {
    const app = makeApp({ running: true, totals: { enqueued: 10, executions: 10, completed: 10, failed: 0, retried: 0 } })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.queue.failureRate).toBe(0)
  })

  it('response includes expected queue fields', async () => {
    const app = makeApp({ running: true, queueDepth: 3, delayedJobs: 1, activeJobs: 2 })
    const res = await request(app)
      .get('/api/jobs/health')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({
      status: 'ok',
      queue: {
        running: true,
        queueDepth: 3,
        delayedJobs: 1,
        activeJobs: 2,
        failureRate: 0,
      },
    })
    expect(typeof res.body.timestamp).toBe('string')
  })
})
