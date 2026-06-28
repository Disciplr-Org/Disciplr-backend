import express from 'express'
import request from 'supertest'
import { describe, expect, it, beforeAll, jest } from '@jest/globals'
import { InMemoryJobQueue } from '../jobs/queue.js'
import { generateValidToken, UserRole } from './helpers/rbacTestUtils.js'
import type { QueueMetrics } from '../jobs/queue.js'
import type { RequestHandler } from 'express'

jest.unstable_mockModule('../lib/audit-logs.js', () => ({
  createAuditLog: jest.fn(),
}))

let createJobsRouter: any
const noopLimiter: RequestHandler = (_req, _res, next) => next()
const adminToken = generateValidToken({ role: UserRole.ADMIN })
const userToken = generateValidToken({ role: UserRole.USER })

beforeAll(async () => {
  const module = await import('../routes/jobs.js')
  createJobsRouter = module.createJobsRouter
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('InMemoryJobQueue dead-letter handling', () => {
  it('moves permanently failing jobs to dead letter after exhausting attempts', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    queue.registerHandler('oracle.call', async () => {
      throw new Error('Permanent failure')
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'XYZ' }, { maxAttempts: 1 })
    queue.start()

    await pause(100)
    await queue.stop()

    const metrics = queue.getMetrics()
    expect(metrics.totals.failed).toBe(1)
    expect(metrics.deadLetterJobs).toBe(1)
    expect(metrics.byType['oracle.call'].deadLetter).toBe(1)
    expect(queue.getDeadLetters()).toHaveLength(1)
    expect(queue.getDeadLetters()[0].error).toBe('Permanent failure')
  })

  it('replays a dead-letter job back into the queue and removes it from DLQ', async () => {
    const queue = new InMemoryJobQueue({ pollIntervalMs: 10 })
    let callCount = 0
    queue.registerHandler('oracle.call', async () => {
      callCount += 1
      if (callCount === 1) {
        throw new Error('Intentional failure')
      }
    })

    queue.enqueue('oracle.call', { oracle: 'test', symbol: 'REPLAY' }, { maxAttempts: 1 })
    queue.start()
    await pause(100)
    await queue.stop()

    const deadLetters = queue.getDeadLetters()
    expect(deadLetters).toHaveLength(1)
    const [entry] = deadLetters

    const replayReceipt = queue.replayDeadLetter(entry.jobId)
    expect(replayReceipt.type).toBe('oracle.call')
    expect(replayReceipt.maxAttempts).toBe(1)

    queue.start()
    await pause(100)
    await queue.stop()

    expect(callCount).toBe(2)
    expect(queue.getDeadLetters()).toHaveLength(0)
    expect(queue.getMetrics().totals.completed).toBe(1)
  })
})

describe('Jobs router dead-letter endpoints', () => {
  const baseMetrics: QueueMetrics = {
    running: true,
    concurrency: 1,
    pollIntervalMs: 10,
    uptimeMs: 100,
    queueDepth: 0,
    delayedJobs: 0,
    activeJobs: 0,
    deadLetterJobs: 1,
    totals: { enqueued: 1, executions: 1, completed: 0, failed: 1, retried: 0 },
    byType: {
      'notification.send': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
      'deadline.check': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
      'oracle.call': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 1, deadLetter: 1 },
      'analytics.recompute': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
      'export.generate': { queued: 0, delayed: 0, active: 0, completed: 0, failed: 0, deadLetter: 0 },
    },
    recentFailures: [
      {
        jobId: 'job-1',
        type: 'oracle.call',
        failedAt: new Date().toISOString(),
        attempts: 1,
        error: 'Permanent failure',
      },
    ],
  }

  const makeApp = (deadLetters: Array<Record<string, unknown>>) => {
    const mockJobSystem = {
      getMetrics: () => baseMetrics,
      getDeadLetters: () => deadLetters,
      getDeadLetter: (id: string) => deadLetters.find((entry) => entry.jobId === id),
      replayDeadLetter: jest.fn((id: string) => {
        const entry = deadLetters.find((item) => item.jobId === id)
        if (!entry) {
          throw new Error('Dead-letter job not found')
        }
        return { id: `replayed-${id}`, type: 'oracle.call', runAt: new Date().toISOString(), maxAttempts: 1 }
      }),
    } as unknown as typeof baseMetrics & {
      getDeadLetters: () => Array<Record<string, unknown>>
      getDeadLetter: (id: string) => Record<string, unknown> | undefined
      replayDeadLetter: (id: string) => Record<string, unknown>
    }

    const app = express()
    app.use(express.json())
    app.use('/api/jobs', createJobsRouter(mockJobSystem, { enqueueLimiter: noopLimiter }))
    return { app, mockJobSystem }
  }

  it('returns dead-letter listing to admin users', async () => {
    const deadLetters = [
      {
        jobId: 'dlq-1',
        type: 'oracle.call',
        payload: { oracle: 'test', symbol: 'X' },
        createdAt: Date.now(),
        runAt: Date.now(),
        maxAttempts: 1,
        failedAt: new Date().toISOString(),
        attempts: 1,
        error: 'Permanent failure',
      },
    ]
    const { app } = makeApp(deadLetters)

    const res = await request(app)
      .get('/api/jobs/deadletters')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.deadLetters).toHaveLength(1)
    expect(res.body.deadLetters[0].jobId).toBe('dlq-1')
  })

  it('returns dead-letter counts in job metrics', async () => {
    const { app } = makeApp([])

    const res = await request(app)
      .get('/api/jobs/metrics')
      .set('Authorization', `Bearer ${adminToken}`)

    expect(res.status).toBe(200)
    expect(res.body.deadLetterJobs).toBe(1)
    expect(res.body.byType['oracle.call'].deadLetter).toBe(1)
  })

  it('replays a dead-letter job and returns a new receipt', async () => {
    const { app, mockJobSystem } = makeApp([
      {
        jobId: 'dlq-2',
        type: 'oracle.call',
        payload: { oracle: 'test', symbol: 'Y' },
        createdAt: Date.now(),
        runAt: Date.now(),
        maxAttempts: 1,
        failedAt: new Date().toISOString(),
        attempts: 1,
        error: 'Permanent failure',
      },
    ])

    const res = await request(app)
      .post('/api/jobs/deadletters/dlq-2/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(202)
    expect(res.body.replayed).toBe(true)
    expect(res.body.job.id).toBe('replayed-dlq-2')
    expect(mockJobSystem.replayDeadLetter).toHaveBeenCalledWith('dlq-2')
  })

  it('returns 404 when replaying a missing dead-letter entry', async () => {
    const { app } = makeApp([])

    const res = await request(app)
      .post('/api/jobs/deadletters/unknown/replay')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})

    expect(res.status).toBe(404)
    expect(res.body.error).toBe('Dead-letter job not found')
  })

  it('returns 403 for non-admin access to dead-letter endpoints', async () => {
    const { app } = makeApp([])

    const res = await request(app)
      .get('/api/jobs/deadletters')
      .set('Authorization', `Bearer ${userToken}`)

    expect(res.status).toBe(403)
  })
})
