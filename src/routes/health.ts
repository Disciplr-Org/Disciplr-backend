import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { startExpirationChecker } from '../services/expirationScheduler.js'
import { horizonListenerConfig } from '../config/horizonListener.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem) => {
  const router = Router()

  router.get('/', (req, res) => {
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      jobs: jobSystem.getMetrics()
    })
  })

  return router
}
