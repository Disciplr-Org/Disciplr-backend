import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { healthService } from '../services/healthService.js'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'
import type { AbuseMonitor } from '../services/abuse-monitor.js'

export const createHealthRouter = (
  jobSystem: BackgroundJobSystem,
  privacyAbuseMonitor?: AbuseMonitor,
): Router => {
  const router = Router()

  router.get('/', async (req, res) => {
    const isDeep = req.query.deep === '1'

    if (isDeep) {
      const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
      return res.status(deepStatus.status === 'error' ? 503 : 200).json(deepStatus)
    }

    return res.status(200).json(healthService.buildHealthStatus('disciplr-api', jobSystem))
  })

  router.get('/deep', async (req, res) => {
    const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
    return res.status(deepStatus.status === 'error' ? 503 : 200).json(deepStatus)
  })

  router.get('/security', async (req, res) => {
    const globalMetrics = getSecurityMetricsSnapshot()
    const securityData: Record<string, unknown> = {
      ...globalMetrics,
      timestamp: new Date().toISOString(),
    }

    if (privacyAbuseMonitor) {
      securityData.privacy = {
        categoryCounts: privacyAbuseMonitor.getCategoryCounts(),
      }
    }

    return res.status(200).json(securityData)
  })

  return router
}
