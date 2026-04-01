import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { startExpirationChecker } from '../services/expirationScheduler.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem) => {
  const router = Router()

  router.get('/', async (req, res) => {
    const isDeep = req.query.deep === '1'
    
    const healthData: any = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      jobs: jobSystem.getMetrics()
    })
  })

  return router
}
