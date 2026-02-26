import { Router } from 'express'
import { getSecurityMetricsSnapshot } from '../security/abuse-monitor.js'

export const healthRouter = Router()

healthRouter.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'disciplr-backend',
    timestamp: new Date().toISOString(),
  })
})

healthRouter.get('/security', (_req, res) => {
  res.json(getSecurityMetricsSnapshot())
})
