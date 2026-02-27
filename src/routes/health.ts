import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem) => {
  const router = Router()

  router.get('/', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      jobs: jobSystem.getUptimeMetrics()
    })
  })

  return router
}
