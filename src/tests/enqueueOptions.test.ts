
import { describe, it, expect, afterAll } from '@jest/globals'
import express, { type Request, type Response, type NextFunction } from 'express'
import request from 'supertest'
import { generateAccessToken } from '../lib/auth-utils.js'
import { UserRole } from '../types/user.js'
import { createJobsRouter } from '../routes/jobs.js'
import { BackgroundJobSystem } from '../jobs/system.js'

const noopLimiter = (_req: Request, _res: Response, next: NextFunction) => next()

const jobSystem = new BackgroundJobSystem()
jobSystem.start()

const testApp = express()
testApp.use(express.json())
testApp.use('/api/jobs', createJobsRouter(jobSystem, { enqueueLimiter: noopLimiter }))

afterAll(async () => {
  await jobSystem.stop()
})

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
 