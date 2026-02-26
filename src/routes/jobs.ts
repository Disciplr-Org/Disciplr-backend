import { Router } from 'express'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  isJobType,
  isPayloadForJobType,
  type EnqueueOptions,
  type JobPayloadByType,
  type JobType,
} from '../jobs/types.js'

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null
}

const parseEnqueueOptions = (body: Record<string, unknown>): EnqueueOptions | null => {
  const options: EnqueueOptions = {}

  if (body.delayMs !== undefined) {
    if (typeof body.delayMs !== 'number' || !Number.isFinite(body.delayMs) || body.delayMs < 0) {
      return null
    }
    options.delayMs = Math.floor(body.delayMs)
  }

  if (body.maxAttempts !== undefined) {
    if (
      typeof body.maxAttempts !== 'number' ||
      !Number.isInteger(body.maxAttempts) ||
      body.maxAttempts < 1 ||
      body.maxAttempts > 10
    ) {
      return null
    }
    options.maxAttempts = body.maxAttempts
  }

  return options
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

export const createJobsRouter = (jobSystem: BackgroundJobSystem): Router => {
  const jobsRouter = Router()

  jobsRouter.get('/metrics', (_req, res) => {
    res.json(jobSystem.getMetrics())
  })

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

  jobsRouter.post('/enqueue', (req, res) => {
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

    const queuedJob = enqueueTypedJob(jobSystem, type, payload, options)
    res.status(202).json({
      queued: true,
      job: queuedJob,
    })
  })

  return jobsRouter
}
