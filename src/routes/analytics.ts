import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { utcNow } from '../utils/timestamps.js'
import {
  getOverallAnalytics,
  getAnalyticsByPeriod,
  getVaultStatusBreakdown,
  getCapitalAnalytics,
} from '../services/analytics.service.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

export const analyticsRouter = Router()

const VALID_PERIODS = ['7d', '30d', '90d', '1y', 'all']

analyticsRouter.get(
  '/',
  authenticateApiKey(['read:analytics']),
  queryParser({
    allowedSortFields: ['timestamp', 'value', 'metric'],
    allowedFilterFields: ['vaultId', 'metric', 'period'],
  }),
  (req: Request, res: Response) => {
    // Legacy in-memory fallback if needed, otherwise returns empty or from db
    const analyticsViews: any[] = []
    let result = [...analyticsViews]
    if (req.filters) result = applyFilters(result, req.filters)
    if (req.sort) result = applySort(result, req.sort)
    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  }
)

analyticsRouter.get('/overview', authenticateApiKey(['read:analytics']), (req: Request, res: Response) => {
  const period = (req.query.period as string) || 'all'
  if (!VALID_PERIODS.includes(period)) {
    return res.status(400).json({ error: `Invalid period. Valid periods: ${VALID_PERIODS.join(', ')}` })
  }
  try {
    const dashboard = period === 'all' ? getOverallAnalytics() : getAnalyticsByPeriod(period)
    const status = getVaultStatusBreakdown()
    const capital = getCapitalAnalytics(period)
    res.json({ dashboard, status, capital, period, generatedAt: utcNow() })
  } catch (error) {
    res.status(500).json({ error: 'Failed' })
  }
})

analyticsRouter.get('/dashboard', authenticateApiKey(['read:analytics']), (_req, res) => {
  res.json(getOverallAnalytics())
})

analyticsRouter.get('/status', authenticateApiKey(['read:analytics']), (_req, res) => {
  res.json(getVaultStatusBreakdown())
})

analyticsRouter.get('/capital', authenticateApiKey(['read:analytics']), (req, res) => {
  const period = (req.query.period as string) || 'all'
  res.json(getCapitalAnalytics(period))
})
