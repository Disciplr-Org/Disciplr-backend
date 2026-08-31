import { Router } from 'express'
import { BackgroundJobSystem } from '../jobs/system.js'
import { healthService } from '../services/healthService.js'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'
import type { AbuseMonitor } from '../services/abuse-monitor.js'
import { authenticate } from '../middleware/auth.js'
import { requireAdmin } from '../middleware/rbac.js'
import { getPendingCount, getDueCount } from '../services/deferredReminders.service.js'

const deepHealthHttpStatus = (status: string): number => {
  if (status === 'error') return 503
  if (status === 'degraded') return 207
  return 200
}

export const createHealthRouter = (
  jobSystem: BackgroundJobSystem,
  privacyAbuseMonitor?: AbuseMonitor,
): Router => {
  const router = Router()

  router.get('/', async (req, res) => {
    const isDeep = req.query.deep === '1'

    if (isDeep) {
      const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
      return res.status(deepHealthHttpStatus(deepStatus.status)).json(deepStatus)
    }

    return res.status(200).json(healthService.buildHealthStatus('disciplr-api', jobSystem))
  })

  router.get('/deep', async (req, res) => {
    const deepStatus = await healthService.buildDeepHealthStatus(jobSystem)
    return res.status(deepHealthHttpStatus(deepStatus.status)).json(deepStatus)
  })

  router.get('/security', authenticate, requireAdmin, async (req, res) => {
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

    try {
      const [pendingCount, dueCount] = await Promise.all([getPendingCount(), getDueCount()])
      securityData.deferredReminders = { pendingCount, dueCount }
    } catch {
      securityData.deferredReminders = { pendingCount: null, dueCount: null, error: 'Failed to query' }
    }

    return res.status(200).json(securityData)
  })

  return router
}
