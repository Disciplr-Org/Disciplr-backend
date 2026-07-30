import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeAll, jest } from '@jest/globals'
import { InMemoryJobQueue } from '../jobs/queue.js'
import { generateValidToken, UserRole } from './helpers/rbacTestUtils.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import type { SweepResult, QueueDepthReport } from '../jobs/queue.js'
import type { RequestHandler } from 'express'

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
}))

let createJobsRouter: any
let createAuditLog: any
const noopLimiter: RequestHandler = (_req, _res, next) => next()
const adminToken = generateValidToken({ userId: 'test-admin', role: UserRole.ADMIN })
const userToken = generateValidToken({ userId: 'test-user', role: UserRole.USER })

beforeAll(async () => {
  const routerModule = await import('../routes/jobs.js')
  createJobsRouter = routerModule.createJobsRouter
  const auditModule = await import('../lib/audit-logs.js')
  createAuditLog = auditModule.createAuditLog
})

/**
 * Forces a pending job into the active map without waiting on real timers,
 * then rewrites its lease timestamp so sweep behaviour is deterministic.
 */
const leaseJobWithAge = async (queue: InMemoryJobQueue, jobId: string, ageMs: number): Promise<void> => {
  const internal = queue as unknown as {
    running: boolean
    drain: () => Promise<void>
    activeJobs: Map<string, { leasedAt?: number }>
  }
  internal.running = true
  await internal.drain()
  internal.running = false
  const job = internal.activeJobs.get(jobId)
  if (!job) {
    throw new Error(`Job ${jobId} did not become active`)
  }
  job.leasedAt = Date.now() - ageMs
}

describe('InMemoryJobQueue.sweepStaleLeases', () => {
  it('reclaims a job whose lease exceeds the stale threshold and retries it', async () => {
    const queue = new InMemoryJobQueue({ concurrency: 1, pollIntervalMs: 10_000 })
    queue.registerHandler('oracle.call', () => new Promise<void>(() => {}))
    const receipt = queue.enqueue('oracle.call', { oracle: 'chainlink', symbol: 'XLM' }, { maxAttempts: 3 })

    await leaseJobWithAge(queue, receipt.id, 10_000)
    expect(queue.getMetrics().activeJobs).toBe(1)

    const result = queue.sweepStaleLeases(5_000)

    expect(result.reclaimed).toHaveLength(1)
    expect(result.reclaimed[0]).toMatchObject({
      jobId: receipt.id,
      type: 'oracle.call',
      attempt: 1,
      maxAttempts: 3,
    })
    expect(result.deadLettered).toHaveLength(0)

    const metrics = queue.getMetrics()
    expect(metrics.activeJobs).toBe(0)
    expect(metrics.queueDepth).toBe(1)
  })

  it('leaves a job untouched when its lease is within the stale threshold', async () => {
    const queue = new InMemoryJobQueue({ concurrency: 1, pollIntervalMs: 10_000 })
    queue.registerHandler('oracle.call', () => new Promise<void>(() => {}))
    const receipt = queue.enqueue('oracle.call', { oracle: 'chainlink', symbol: 'XLM' }, { maxAttempts: 3 })

    await leaseJobWithAge(queue, receipt.id, 100)

    const result = queue.sweepStaleLeases(5_000)

    expect(result.reclaimed).toHaveLength(0)
    expect(result.deadLettered).toHaveLength(0)
    expect(queue.getMetrics().activeJobs).toBe(1)
  })

  it('routes a stuck job to the dead-letter queue once max attempts are reached', async () => {
    const queue = new InMemoryJobQueue({ concurrency: 1, pollIntervalMs: 10_000 })
    queue.registerHandler('oracle.call', () => new Promise<void>(() => {}))
    const receipt = queue.enqueue('oracle.call', { oracle: 'chainlink', symbol: 'XLM' }, { maxAttempts: 1 })

    await leaseJobWithAge(queue, receipt.id, 10_000)

    const result = queue.sweepStaleLeases(5_000)

    expect(result.reclaimed).toHaveLength(0)
    expect(result.deadLettered).toHaveLength(1)
    expect(result.deadLettered[0].jobId).toBe(receipt.id)
    expect(queue.getDeadLetters()).toHaveLength(1)
    expect(queue.getMetrics().activeJobs).toBe(0)
    expect(queue.getMetrics().totals.failed).toBe(1)
  })

  it('resumes draining automatically after a reclaim when the queue is running', async () => {
    const queue = new InMemoryJobQueue({ concurrency: 1, pollIntervalMs: 10_000 })
    let callCount = 0
    queue.registerHandler('oracle.call', () => {
      callCount += 1
      return callCount === 1 ? new Promise<void>(() => {}) : Promise.resolve()
    })
    const receipt = queue.enqueue('oracle.call', { oracle: 'chainlink', symbol: 'XLM' }, { maxAttempts: 3 })

    await leaseJobWithAge(queue, receipt.id, 10_000)

    const internal = queue as unknown as { running: boolean }
    internal.running = true
    const result = queue.sweepStaleLeases(5_000)
    internal.running = false

    expect(result.reclaimed).toHaveLength(1)
    expect(callCount).toBe(2)
    expect(queue.getMetrics().activeJobs).toBe(1)
  })
})

describe('InMemoryJobQueue.getQueueDepthReport', () => {
  it('groups depth by job type and state, including stuck-active and dead-lettered jobs', async () => {
    const queue = new InMemoryJobQueue({ concurrency: 2, pollIntervalMs: 10_000 })
    queue.registerHandler('notification.send', () => new Promise<void>(() => {}))
    queue.registerHandler('deadline.check', () => new Promise<void>(() => {}))
    queue.registerHandler('oracle.call', () => new Promise<void>(() => {}))

    // Stuck active job — leased well past the threshold.
    const stuck = queue.enqueue(
      'notification.send',
      { recipient: 'ops@example.com', subject: 's', body: 'b' },
      { maxAttempts: 3 },
    )
    await leaseJobWithAge(queue, stuck.id, 10_000)

    // Fresh active job — leased moments ago, under the threshold.
    const fresh = queue.enqueue('deadline.check', { triggerSource: 'manual' }, { maxAttempts: 3 })
    await leaseJobWithAge(queue, fresh.id, 100)

    // Untouched queued and delayed jobs.
    queue.enqueue('oracle.call', { oracle: 'a', symbol: 'A' }, { maxAttempts: 3 })
    queue.enqueue('oracle.call', { oracle: 'b', symbol: 'B' }, { delayMs: 60_000, maxAttempts: 3 })

    // Synthetic dead-letter entry to exercise the deadLetter grouping.
    const internal = queue as unknown as {
      deadLetterJobs: Array<Record<string, unknown>>
    }
    internal.deadLetterJobs.push({
      jobId: 'dlq-synthetic',
      type: 'analytics.recompute',
      failedAt: new Date().toISOString(),
      attempts: 1,
      error: 'exhausted',
      payload: { scope: 'global' },
      createdAt: Date.now(),
      runAt: Date.now(),
      maxAttempts: 1,
    })

    const report = queue.getQueueDepthReport(5_000)

    expect(report.byType['oracle.call']).toMatchObject({
      queued: 1,
      delayed: 1,
      active: 0,
      stuckActive: 0,
      deadLetter: 0,
    })
    expect(report.byType['notification.send']).toMatchObject({
      queued: 0,
      delayed: 0,
      active: 1,
      stuckActive: 1,
      deadLetter: 0,
    })
    expect(report.byType['deadline.check']).toMatchObject({
      queued: 0,
      delayed: 0,
      active: 1,
      stuckActive: 0,
      deadLetter: 0,
    })
    expect(report.byType['analytics.recompute']).toMatchObject({
      queued: 0,
      delayed: 0,
      active: 0,
      stuckActive: 0,
      deadLetter: 1,
    })
    expect(report.totalDepth).toBe(4)
  })
})

describe('Jobs router — depth and sweep endpoints', () => {
  const makeApp = (mockJobSystem: Partial<BackgroundJobSystem>) => {
    const app = express()
    app.use(express.json())
    app.use('/api/jobs', createJobsRouter(mockJobSystem as BackgroundJobSystem, { enqueueLimiter: noopLimiter }))
    return app
  }

  it('returns 401 with no token on /depth', async () => {
    const app = makeApp({})
    const res = await request(app).get('/api/jobs/depth')
    expect(res.status).toBe(401)
  })

  it('returns 403 for non-admin role on /depth', async () => {
    const app = makeApp({})
    const res = await request(app).get('/api/jobs/depth').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(403)
  })

  it('returns the depth report for an admin', async () => {
    const report: QueueDepthReport = {
      generatedAt: new Date().toISOString(),
      staleLeaseMs: 300_000,
      totalDepth: 2,
      byType: {
        'notification.send': { queued: 1, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 },
        'deadline.check': { queued: 0, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 },
        'oracle.call': { queued: 0, delayed: 0, active: 1, stuckActive: 1, deadLetter: 0 },
        'analytics.recompute': { queued: 0, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 },
        'export.generate': { queued: 0, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 },
        'sessions.cleanup': { queued: 0, delayed: 0, active: 0, stuckActive: 0, deadLetter: 0 },
      },
    }
    const getQueueDepthReport = jest.fn(() => report)
    const app = makeApp({ getQueueDepthReport })

    const res = await request(app).get('/api/jobs/depth').set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(report)
    expect(getQueueDepthReport).toHaveBeenCalledWith(undefined)
  })

  it('passes a valid staleLeaseMs query param through to the job system', async () => {
    const getQueueDepthReport = jest.fn(() => ({
      generatedAt: new Date().toISOString(),
      staleLeaseMs: 60_000,
      totalDepth: 0,
      byType: {},
    }))
    const app = makeApp({ getQueueDepthReport })

    const res = await request(app)
      .get('/api/jobs/depth?staleLeaseMs=60000')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(getQueueDepthReport).toHaveBeenCalledWith(60_000)
  })

  it('rejects an invalid staleLeaseMs query param', async () => {
    const app = makeApp({ getQueueDepthReport: jest.fn() })

    const res = await request(app)
      .get('/api/jobs/depth?staleLeaseMs=not-a-number')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
  })

  it('returns 403 for non-admin role on /sweep', async () => {
    const app = makeApp({})
    const res = await request(app).post('/api/jobs/sweep').set('Authorization', `Bearer ${userToken}`)
    expect(res.status).toBe(403)
  })

  it('triggers a sweep, returns the result, and records an audit log', async () => {
    const sweepResult: SweepResult = {
      sweptAt: new Date().toISOString(),
      staleLeaseMs: 300_000,
      reclaimed: [{ jobId: 'job-1', type: 'oracle.call', attempt: 1, maxAttempts: 3, leaseAgeMs: 400_000 }],
      deadLettered: [],
    }
    const sweepStaleLeases = jest.fn(() => sweepResult)
    const app = makeApp({ sweepStaleLeases })

    const res = await request(app).post('/api/jobs/sweep').set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(sweepResult)
    expect(sweepStaleLeases).toHaveBeenCalledWith(undefined)
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'test-admin',
        action: 'job.sweep',
        target_type: 'job_queue',
        metadata: {
          staleLeaseMs: 300_000,
          reclaimedCount: 1,
          deadLetteredCount: 0,
        },
      }),
    )
  })

  it('rejects an invalid staleLeaseMs query param on /sweep', async () => {
    const app = makeApp({ sweepStaleLeases: jest.fn() })

    const res = await request(app)
      .post('/api/jobs/sweep?staleLeaseMs=-5')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(400)
  })
})
