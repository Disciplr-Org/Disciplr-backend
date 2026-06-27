import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { InMemoryJobQueue } from '../jobs/queue.js'
import { JOB_TYPES, type JobPayloadByType, type JobType } from '../jobs/types.js'
import { generateValidToken, UserRole } from './helpers/rbacTestUtils.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import type { QueueDepthReport, StuckJobSweepResult } from '../jobs/queue.js'
import type { RequestHandler } from 'express'

const createAuditLog = mock(() => {})

mock.module('../lib/audit-logs.js', () => ({
  createAuditLog,
}))

const { createJobsRouter } = await import('../routes/jobs.js')

const noopLimiter: RequestHandler = (_req, _res, next) => next()
const adminToken = generateValidToken({ userId: 'admin-jobs-sweeper', role: UserRole.ADMIN })
const userToken = generateValidToken({ userId: 'user-jobs-sweeper', role: UserRole.USER })

interface ActiveJobSeed<T extends JobType = JobType> {
  id: string
  type: T
  payload: JobPayloadByType[T]
  attempt: number
  maxAttempts: number
  createdAt: number
  runAt: number
  activeSince: number
  leaseId: number
}

const seedActiveJob = (queue: InMemoryJobQueue, job: ActiveJobSeed) => {
  const internals = queue as unknown as {
    activeJobs: Map<string, ActiveJobSeed>
  }
  internals.activeJobs.set(job.id, job)
}

const emptyTypeMetrics = () => Object.fromEntries(
  JOB_TYPES.map((type) => [
    type,
    { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
  ]),
) as QueueDepthReport['byType']

const makeDepthReport = (): QueueDepthReport => ({
  generatedAt: '2026-06-27T04:00:00.000Z',
  totals: {
    queued: 2,
    delayed: 1,
    active: 1,
    deadLetter: 0,
  },
  byType: {
    ...emptyTypeMetrics(),
    'oracle.call': { queued: 1, delayed: 0, active: 1, completed: 0, failed: 0, deadLetter: 0 },
    'sessions.cleanup': { queued: 0, delayed: 1, active: 0, completed: 0, failed: 0, deadLetter: 0 },
  },
})

const makeSweepResult = (): StuckJobSweepResult => ({
  scannedActive: 2,
  staleAfterMs: 1_000,
  reclaimed: 1,
  deadLettered: 1,
  untouched: 0,
  reclaimedJobs: [
    {
      jobId: 'stale-reclaimed',
      type: 'oracle.call',
      attempt: 1,
      maxAttempts: 3,
      activeForMs: 5_000,
    },
  ],
  deadLetteredJobs: [
    {
      jobId: 'stale-deadletter',
      type: 'notification.send',
      attempt: 1,
      maxAttempts: 1,
      activeForMs: 5_000,
    },
  ],
})

const makeApp = (jobSystem: Partial<BackgroundJobSystem>) => {
  const app = express()
  app.use(express.json())
  app.use('/api/jobs', createJobsRouter(jobSystem as BackgroundJobSystem, { enqueueLimiter: noopLimiter }))
  return app
}

describe('InMemoryJobQueue depth reporting and stuck-job sweeper', () => {
  test('depth report groups queued and delayed jobs by every supported type', () => {
    const queue = new InMemoryJobQueue()
    queue.registerHandler('oracle.call', async () => {})
    queue.registerHandler('sessions.cleanup', async () => {})

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XLM' })
    queue.enqueue('sessions.cleanup', {}, { delayMs: 60_000 })

    const report = queue.getDepthReport()

    expect(report.totals.queued).toBe(1)
    expect(report.totals.delayed).toBe(1)
    expect(report.byType['oracle.call'].queued).toBe(1)
    expect(report.byType['sessions.cleanup'].delayed).toBe(1)
    expect(Object.keys(report.byType).sort()).toEqual([...JOB_TYPES].sort())
  })

  test('sweeper leaves fresh active leases untouched', () => {
    const now = Date.now()
    const queue = new InMemoryJobQueue()
    seedActiveJob(queue, {
      id: 'fresh-job',
      type: 'oracle.call',
      payload: { oracle: 'test', symbol: 'XLM' },
      attempt: 1,
      maxAttempts: 3,
      createdAt: now - 5_000,
      runAt: now - 5_000,
      activeSince: now - 100,
      leaseId: 1,
    })

    const result = queue.sweepStuckJobs({ staleAfterMs: 1_000, now })

    expect(result).toMatchObject({
      scannedActive: 1,
      reclaimed: 0,
      deadLettered: 0,
      untouched: 1,
    })
    expect(queue.getMetrics().activeJobs).toBe(1)
  })

  test('sweeper requeues stale jobs that still have attempts remaining', () => {
    const now = Date.now()
    const queue = new InMemoryJobQueue()
    seedActiveJob(queue, {
      id: 'stale-reclaimed',
      type: 'oracle.call',
      payload: { oracle: 'test', symbol: 'XLM' },
      attempt: 1,
      maxAttempts: 3,
      createdAt: now - 10_000,
      runAt: now - 10_000,
      activeSince: now - 5_000,
      leaseId: 1,
    })

    const result = queue.sweepStuckJobs({ staleAfterMs: 1_000, now })

    expect(result.reclaimed).toBe(1)
    expect(result.deadLettered).toBe(0)
    expect(result.reclaimedJobs[0]).toMatchObject({
      jobId: 'stale-reclaimed',
      type: 'oracle.call',
      attempt: 1,
      maxAttempts: 3,
    })
    expect(queue.getMetrics().activeJobs).toBe(0)
    expect(queue.getMetrics().queueDepth).toBe(1)
  })

  test('sweeper dead-letters stale jobs that exhausted max attempts', () => {
    const now = Date.now()
    const queue = new InMemoryJobQueue()
    seedActiveJob(queue, {
      id: 'stale-deadletter',
      type: 'notification.send',
      payload: { recipient: 'ops@example.com', subject: 'queued', body: 'stuck' },
      attempt: 1,
      maxAttempts: 1,
      createdAt: now - 10_000,
      runAt: now - 10_000,
      activeSince: now - 5_000,
      leaseId: 1,
    })

    const result = queue.sweepStuckJobs({ staleAfterMs: 1_000, now })

    expect(result.deadLettered).toBe(1)
    expect(result.reclaimed).toBe(0)
    expect(queue.getMetrics().activeJobs).toBe(0)
    expect(queue.getMetrics().deadLetterJobs).toBe(1)
    expect(queue.getDeadLetters()[0]).toMatchObject({
      jobId: 'stale-deadletter',
      error: 'Job lease expired after 5000ms',
    })
  })
})

describe('Jobs router depth and stuck-job sweep endpoints', () => {
  beforeEach(() => {
    createAuditLog.mockClear()
  })

  test('returns queue depth report for admins', async () => {
    const report = makeDepthReport()
    const app = makeApp({
      getDepthReport: mock(() => report),
    })

    const res = await request(app)
      .get('/api/jobs/depth')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body).toEqual(report)
    expect(res.body.byType['sessions.cleanup'].delayed).toBe(1)
  })

  test('rejects depth report for non-admin users', async () => {
    const app = makeApp({
      getDepthReport: mock(() => makeDepthReport()),
    })

    const res = await request(app)
      .get('/api/jobs/depth')
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(403)
  })

  test('sweeps stale jobs and records an audit log', async () => {
    const result = makeSweepResult()
    const sweepStuckJobs = mock(() => result)
    const app = makeApp({ sweepStuckJobs })

    const res = await request(app)
      .post('/api/jobs/sweep-stuck')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ staleAfterMs: 1_000 })

    expect(res.status).toBe(202)
    expect(res.body).toEqual({ swept: true, result })
    expect(sweepStuckJobs).toHaveBeenCalledWith({ staleAfterMs: 1_000 })
    expect(createAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_user_id: 'admin-jobs-sweeper',
        action: 'job.sweep_stuck',
        target_type: 'job_queue',
        metadata: {
          staleAfterMs: 1_000,
          scannedActive: 2,
          reclaimed: 1,
          deadLettered: 1,
        },
      }),
    )
  })

  test('rejects invalid staleAfterMs values before sweeping', async () => {
    const sweepStuckJobs = mock(() => makeSweepResult())
    const app = makeApp({ sweepStuckJobs })

    const res = await request(app)
      .post('/api/jobs/sweep-stuck')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ staleAfterMs: 0 })

    expect(res.status).toBe(400)
    expect(sweepStuckJobs).not.toHaveBeenCalled()
  })
})
