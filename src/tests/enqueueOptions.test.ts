
import './initTestEnv.js'
import { describe, it, expect, afterAll } from '@jest/globals'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'
import { createJobsRouter } from '../routes/jobs.js'
import { BackgroundJobSystem } from '../jobs/system.js'
import { parseEnqueueOptions } from '../jobs/enqueueOptions.js'
import { JOB_TYPES } from '../jobs/types.js'

import { setAuditLogWriterForTests } from '../lib/audit-logs.js'

process.env.ENABLE_JOB_SCHEDULER = 'false'
setAuditLogWriterForTests(async (entry: any) => ({
  id: 'test-audit-id',
  created_at: new Date().toISOString(),
  ...entry,
}))

const noopLimiter = (_req: Request, _res: Response, next: NextFunction) => next()

const jobSystem = new BackgroundJobSystem()

const testApp = express()
testApp.use(express.json())
testApp.use('/api/jobs', createJobsRouter(jobSystem, { enqueueLimiter: noopLimiter }))

const adminToken = generateAccessToken({ userId: 'admin-enqueue-options-test', role: UserRole.ADMIN })

describe('Jobs API Zod Validation - POST /api/jobs/enqueue', () => {
  it('returns 202 and queued: true for a valid payload and options', async () => {
    const res = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: 'user@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        },
        maxAttempts: 5,
        delayMs: 1000,
      })
      .expect(202)

    expect(res.body).toMatchObject({
      queued: true,
      job: {
        type: 'notification.send',
        maxAttempts: 5,
      },
    })
  })

  it('successfully enqueues every supported job type in JOB_TYPES', async () => {
    const validPayloads: Record<string, object> = {
      'notification.send': { recipient: 'user@example.com', subject: 'Subject', body: 'Body' },
      'deadline.check': { triggerSource: 'manual' },
      'milestone.reminders': { leadTimesMs: [86400000], limit: 10 },
      'milestone.reminders.digest': { leadTimesMs: [86400000], limit: 10 },
      'milestone.reminders.deferred': { batchSize: 50 },
      'oracle.call': { oracle: 'stellar-oracle', symbol: 'XLM' },
      'analytics.recompute': { scope: 'global' },
      'analytics.report.generate': { orgIds: ['org-1'] },
      'export.generate': { exportJobId: 'exp-123' },
      'vault.reconcile': { vaultIds: ['vault-1'], batchSize: 20 },
      'sessions.cleanup': { batchSize: 100 },
      'retention.purge': { organizationId: 'org-1', batchSize: 50 },
      'outbox.relay': { batchSize: 10 },
      'embeddings.reindex': { batchSize: 25, maxBatchesPerRun: 5 },
      'saved-search.evaluate': { searchId: 'search-1', batchSize: 10 },
    }

    for (const jobType of JOB_TYPES) {
      const payload = validPayloads[jobType]
      expect(payload).toBeDefined()

      const res = await request(testApp)
        .post('/api/jobs/enqueue')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          type: jobType,
          payload,
        })

      if (res.status !== 202) {
        console.error(`Failed to enqueue jobType ${jobType}:`, res.status, res.body)
      }

      expect(res.status).toBe(202)
      expect(res.body).toMatchObject({
        queued: true,
        job: {
          type: jobType,
        },
      })
    }
  })

  it('returns 400 and VALIDATION_ERROR details for invalid payload shape', async () => {
    const res = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: '', // Empty recipient is invalid
          subject: 'Test Subject',
          // Missing body
        },
      })
      .expect(400)

    expect(res.body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        details: expect.any(Array),
      },
    })

    // Check that we have details about the missing body or empty recipient
    const errors = res.body.error.details
    expect(errors.some((err: any) => err.path.includes('body'))).toBe(true)
    expect(errors.some((err: any) => err.path.includes('recipient'))).toBe(true)
  })

  it('returns 400 and validation error when maxAttempts is out of bounds', async () => {
    // maxAttempts below 1
    const resBelow = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: 'user@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        },
        maxAttempts: 0,
      })
      .expect(400)

    expect(resBelow.body.success).toBe(false)
    expect(resBelow.body.error.code).toBe('VALIDATION_ERROR')
    expect(resBelow.body.error.details.some((err: any) => err.path.includes('maxAttempts'))).toBe(true)

    // maxAttempts above 10
    const resAbove = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: 'user@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        },
        maxAttempts: 11,
      })
      .expect(400)

    expect(resAbove.body.success).toBe(false)
    expect(resAbove.body.error.code).toBe('VALIDATION_ERROR')
    expect(resAbove.body.error.details.some((err: any) => err.path.includes('maxAttempts'))).toBe(true)
  })

  it('returns 400 and validation error when delayMs is out of bounds', async () => {
    // delayMs below 0
    const resBelow = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: 'user@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        },
        delayMs: -1,
      })
      .expect(400)

    expect(resBelow.body.success).toBe(false)
    expect(resBelow.body.error.code).toBe('VALIDATION_ERROR')
    expect(resBelow.body.error.details.some((err: any) => err.path.includes('delayMs'))).toBe(true)

    // delayMs above 60000
    const resAbove = await request(testApp)
      .post('/api/jobs/enqueue')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'notification.send',
        payload: {
          recipient: 'user@example.com',
          subject: 'Test Subject',
          body: 'Test Body',
        },
        delayMs: 60001,
      })
      .expect(400)

    expect(resAbove.body.success).toBe(false)
    expect(resAbove.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('returns null for invalid enqueue option values', () => {
    expect(parseEnqueueOptions({ delayMs: -1 })).toBeNull()
    expect(parseEnqueueOptions({ delayMs: NaN })).toBeNull()
    expect(parseEnqueueOptions({ maxAttempts: 0 })).toBeNull()
    expect(parseEnqueueOptions({ maxAttempts: 11 })).toBeNull()
    expect(parseEnqueueOptions({ maxAttempts: 3.5 })).toBeNull()
    expect(parseEnqueueOptions({ delayMs: 1000, maxAttempts: 5 })).toEqual({ delayMs: 1000, maxAttempts: 5 })
  })
})
 