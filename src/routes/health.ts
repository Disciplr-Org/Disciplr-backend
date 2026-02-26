import { Router } from 'express'
import { utcNow } from '../utils/timestamps.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'

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
<<<<<<< HEAD
=======
healthRouter.get('/', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'disciplr-backend',
    timestamp: utcNow(),
  })
})
>>>>>>> upstream/main

