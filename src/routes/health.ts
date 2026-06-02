import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { healthService } from '../services/healthService.js'

export const createHealthRouter = (jobSystem: BackgroundJobSystem): Router => {
  const router = Router()

  router.get('/', async (req, res) => {
    const isDeep = req.query.deep === '1'

    if (isDeep) {
      const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
      return res.status(deepStatus.status === 'error' ? 503 : 200).json(deepStatus)
    }

    return res.status(200).json(healthService.buildHealthStatus('disciplr-api', jobSystem))
  })

  return router
}
