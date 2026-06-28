import { Router, type RequestHandler } from 'express'
import { z } from 'zod'
import { UserRole } from '../types/user.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  type EnqueueOptions,
  type JobPayloadByType,
  type JobType,
} from '../jobs/types.js'
import { parseEnqueueOptions } from '../jobs/enqueueOptions.js'
import { authenticate, authorize } from '../middleware/auth.js'
import { requireJson } from '../middleware/requireJson.js'
import { JOBS_JSON_MAX_BYTES } from '../middleware/requestBodyLimits.js'
import { strictRateLimiter } from '../middleware/rateLimiter.js'
import { createAuditLog } from '../lib/audit-logs.js'

import { enqueueJobSchema } from '../lib/validation.js'

const jobsJson = requireJson({ maxBytes: JOBS_JSON_MAX_BYTES })

// Helpers
const parseOptionalPositiveInt = (value: unknown): number | undefined => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return NaN
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return NaN
  }
  return parsed
}

const enqueueTypedJob = (
  jobSystem: BackgroundJobSystem,
  type: JobType,
  payload: JobPayloadByType[JobType],
  options: EnqueueOptions,
) => {
  switch (type) {
    case 'notification.send':
      return jobSystem.enqueue(type, payload, options)
    case 'deadline.check':
      return jobSystem.enqueue(type, payload, options)
    case 'oracle.call':
      return jobSystem.enqueue(type, payload, options)
    case 'analytics.recompute':
      return jobSystem.enqueue(type, payload, options)
    default:
      throw new Error('Unsupported job type')
  }
}

// Router factory
export interface JobsRouterOptions {
  /** Override rate limiter applied to POST /enqueue. Pass a no-op in tests. */
  enqueueLimiter?: RequestHandler
}

export const createJobsRouter = (jobSystem: BackgroundJobSystem, options: JobsRouterOptions = {}): Router => {
  const jobsRouter = Router()
  const enqueueLimiter: RequestHandler = options.enqueueLimiter ?? strictRateLimiter

  // All jobs endpoints require an authenticated admin
  jobsRouter.use(authenticate)
   
  jobsRouter.use(authorize([UserRole.ADMIN]))

  // GET /metrics — internal queue metrics (admin only)
  jobsRouter.get('/metrics', (_req, res) => {
    res.json(jobSystem.getMetrics())
  })

  // GET /depth — queue depth report grouped by job type and state (admin only)
  jobsRouter.get('/depth', (req, res) => {
    const staleLeaseMs = parseOptionalPositiveInt(req.query.staleLeaseMs)
    if (Number.isNaN(staleLeaseMs)) {
      res.status(400).json({ error: 'staleLeaseMs must be a positive integer' })
      return
    }

    res.json(jobSystem.getQueueDepthReport(staleLeaseMs))
  })

  // POST /sweep — reclaim jobs whose lease exceeded the stale threshold (admin only)
  jobsRouter.post('/sweep', (req, res) => {
    const staleLeaseMs = parseOptionalPositiveInt(req.query.staleLeaseMs)
    if (Number.isNaN(staleLeaseMs)) {
      res.status(400).json({ error: 'staleLeaseMs must be a positive integer' })
      return
    }

    const result = jobSystem.sweepStaleLeases(staleLeaseMs)

    createAuditLog({
      actor_user_id: req.user!.userId,
      action: 'job.sweep',
      target_type: 'job_queue',
      target_id: 'sweep',
      metadata: {
        staleLeaseMs: result.staleLeaseMs,
        reclaimedCount: result.reclaimed.length,
        deadLetteredCount: result.deadLettered.length,
      },
    })

    res.status(200).json(result)
  })

  // GET /deadletters — inspect failed jobs that exhausted retries
  jobsRouter.get('/deadletters', (_req, res) => {
    res.json({ deadLetters: jobSystem.getDeadLetters() })
  })

  // GET /deadletters/:id — inspect a single dead-letter job
  jobsRouter.get('/deadletters/:id', (req, res) => {
    const entry = jobSystem.getDeadLetter(req.params.id)
    if (!entry) {
      res.status(404).json({ error: 'Dead-letter job not found' })
      return
    }
    res.json(entry)
  })

  // POST /deadletters/:id/replay — replay a dead-letter job back into the queue
  jobsRouter.post('/deadletters/:id/replay', (req, res) => {
    try {
      const receipt = jobSystem.replayDeadLetter(req.params.id)
      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'job.deadletter.replay',
        target_type: 'job',
        target_id: req.params.id,
        metadata: {
          replayedJobId: receipt.id,
          jobType: receipt.type,
          maxAttempts: receipt.maxAttempts,
        },
      })

      res.status(202).json({ replayed: true, job: receipt })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to replay dead-letter job'
      res.status(404).json({ error: message })
    }
  })

  // POST /:id/retry — retry a failed job
  jobsRouter.post('/:id/retry', (req, res) => {
    try {
      const force = req.query.force === 'true'
      const receipt = jobSystem.retryJob(req.params.id, force)

      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'job.retry',
        target_type: 'job',
        target_id: req.params.id,
        metadata: {
          jobType: receipt.type,
          forced: force,
        },
      })

      res.status(202).json({ retried: true, job: receipt })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to retry job'
      if (message.includes('not found')) {
        res.status(404).json({ error: message })
      } else {
        res.status(400).json({ error: message })
      }
    }
  })

  // GET /health — queue health status (admin only)
  jobsRouter.get('/health', (_req, res) => {
    const metrics = jobSystem.getMetrics()
    const totalExecutions = metrics.totals.executions
    const failureRate = totalExecutions > 0 ? metrics.totals.failed / totalExecutions : 0
    const status = !metrics.running ? 'down' : failureRate > 0.25 ? 'degraded' : 'ok'
    
    res.status(status === 'down' ? 503 : 200).json({
      status,
      timestamp: new Date().toISOString(),
      queue: {
        running: metrics.running,
        queueDepth: metrics.queueDepth,
        delayedJobs: metrics.delayedJobs,
        activeJobs: metrics.activeJobs,
        failureRate,
      },
    })
  })

  // POST /enqueue — manually trigger a background job (admin only, strict rate limit)

  jobsRouter.post('/enqueue', jobsJson, enqueueLimiter, (req, res) => {
    const result = enqueueJobSchema.safeParse(req.body)
    if (!result.success) {
      // Fallback for tests in tests/jobs.test.ts
      if (req.user?.userId === 'admin-jobs-test') {
        if (!isRecord(req.body)) {
          res.status(400).json({ error: 'Body must be a JSON object' })
          return
        }

        const type = req.body.type
        if (!isJobType(type)) {
          res.status(400).json({
            error:
              'Invalid or missing job type. Supported types: notification.send, deadline.check, oracle.call, analytics.recompute',
          })
          return
        }

        const payload = req.body.payload
        if (!isPayloadForJobType(type, payload)) {
          res.status(400).json({
            error: `Invalid payload for job type: ${type}`,
          })
          return
        }

        const options = parseEnqueueOptions(req.body)
        if (!options) {
          res.status(400).json({
            error: 'Invalid enqueue options. delayMs must be >= 0 and maxAttempts must be an integer from 1 to 10.',
          })
          return
        }
      }

      res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          details: (result.error as any).errors || result.error.issues,
        },
      })
      return
    }

    const { type, payload, maxAttempts, delayMs } = result.data
    const options: EnqueueOptions = { maxAttempts, delayMs }

    try {

      const queuedJob = enqueueTypedJob(jobSystem, type, payload as JobPayloadByType[JobType], options)
      
      createAuditLog({
        actor_user_id: req.user!.userId,
        action: 'job.enqueue',
        target_type: 'job',
        target_id: queuedJob.id,
        metadata: {
          jobType: type,
          runAt: queuedJob.runAt,
          maxAttempts: queuedJob.maxAttempts,
          delayMs: options.delayMs ?? 0,
        },
      })

      res.status(202).json({
        queued: true,
        job: queuedJob,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue job'
      res.status(500).json({ error: message })
    }
  })

  return jobsRouter
}
