import { Router } from 'express'
import { getMetrics } from '../middleware/metrics.js'

export const metricsRouter = Router()

metricsRouter.get('/', async (_req, res) => {
  try {
    const metrics = await getMetrics()
    res.set('Content-Type', 'text/plain')
    res.send(metrics)
  } catch (error) {
    console.error('Error generating metrics:', error)
    res.status(500).json({ error: 'Failed to generate metrics' })
  }
})
