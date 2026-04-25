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
    }
    
    if (isDeep) {
      // Import health service dynamically to avoid circular dependencies
      const { healthService } = await import('../services/healthService.js')
      
      try {
        const [databaseStatus, horizonStatus] = await Promise.all([
          healthService.checkDatabase(),
          healthService.checkHorizon()
        ])
        
        healthData.details = {
          database: databaseStatus,
          horizon: horizonStatus
        }
        
        // Check if any service is down
        const anyServiceDown = [databaseStatus, horizonStatus].some(
          service => service.status === 'down'
        )
        
        if (anyServiceDown) {
          healthData.status = 'error'
          return res.status(503).json(healthData)
        }
      } catch (error) {
        healthData.status = 'error'
        healthData.details = {
          database: { status: 'down', error: 'Connection failed' },
          horizon: { status: 'down', error: 'Connection failed' }
        }
        return res.status(503).json(healthData)
      }
    }
    
    res.json(healthData)
  })

  return router
}
