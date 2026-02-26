import { Router } from 'express'
import { utcNow } from '../utils/timestamps.js'
import type { BackgroundJobSystem } from '../jobs/system.js'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'

export const healthRouter = Router()
export const createHealthRouter = (jobSystem: BackgroundJobSystem): Router => {

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
// healthRouter.get('/', (_req: Request, res: Response) => {
//   res.json({
//     status: 'ok',
//     service: 'disciplr-backend',
//     timestamp: utcNow(),
//   })
// })

healthRouter.get('/security', (_req, res) => {
  res.json(getSecurityMetricsSnapshot())
})
