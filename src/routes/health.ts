import { Router } from 'express'
import type { BackgroundJobSystem } from '../jobs/system.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem): Router => {
  const healthRouter = Router()

  healthRouter.get('/', (_req, res) => {
    const queueMetrics = jobSystem.getMetrics()
    const status = queueMetrics.running ? 'ok' : 'degraded'

    res.status(status === 'ok' ? 200 : 503).json({
      status,
      service: 'disciplr-backend',
      timestamp: new Date().toISOString(),
      jobs: {
        running: queueMetrics.running,
        queueDepth: queueMetrics.queueDepth,
        delayedJobs: queueMetrics.delayedJobs,
        activeJobs: queueMetrics.activeJobs,
      },
    })
  })

  return healthRouter
}
