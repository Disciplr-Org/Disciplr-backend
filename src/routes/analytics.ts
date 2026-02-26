import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { utcNow } from '../utils/timestamps.js'
import {
  getOverallAnalytics,
  getAnalyticsByPeriod,
  getVaultStatusBreakdown,
  getCapitalAnalytics,
} from '../services/analytics.service.js'

export const analyticsRouter = Router()

const analyticsViews: Array<{
  id: string
  vaultId: string
  metric: string
  value: number
  timestamp: string
  period: 'daily' | 'weekly' | 'monthly'
}> = []

analyticsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['timestamp', 'value', 'metric'],
    allowedFilterFields: ['vaultId', 'metric', 'period'],
  }),
  (req: Request, res: Response) => {
    let result = [...analyticsViews]
    if (req.filters) {
      result = applyFilters(result, req.filters)
    }
    if (req.sort) {
      result = applySort(result, req.sort)
    }
    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  }
)

analyticsRouter.get('/vaults', authenticateApiKey(['read:vaults']), (_req: Request, res: Response) => {
  res.json({
    metrics: {
      totalVaults: 16,
      activeVaults: 4,
      completionRate: 0.75,
    },
    generatedAt: utcNow(),
  })
})

const VALID_PERIODS = ['7d', '30d', '90d', '1y', 'all']

analyticsRouter.get('/dashboard', authenticateApiKey(['read:analytics']), (_req, res) => {
  try {
    const analytics = getOverallAnalytics()
    res.json(analytics)
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error)
    res.status(500).json({ error: 'Failed to fetch dashboard analytics' })
  }
})

analyticsRouter.get('/dashboard/:period', authenticateApiKey(['read:analytics']), (req, res) => {
  const { period } = req.params
  if (!VALID_PERIODS.includes(period)) {
    res.status(400).json({
      error: `Invalid period. Valid periods: ${VALID_PERIODS.join(', ')}`,
    })
    return
  }
  try {
    const analytics = getAnalyticsByPeriod(period)
    res.json(analytics)
  } catch (error) {
    console.error('Error fetching period analytics:', error)
    res.status(500).json({ error: 'Failed to fetch period analytics' })
  }
})

analyticsRouter.get('/status', authenticateApiKey(['read:analytics']), (_req, res) => {
  try {
    const breakdown = getVaultStatusBreakdown()
    res.json(breakdown)
  } catch (error) {
    console.error('Error fetching status breakdown:', error)
    res.status(500).json({ error: 'Failed to fetch status breakdown' })
  }
})

analyticsRouter.get('/capital', authenticateApiKey(['read:analytics']), (req, res) => {
  const period = (req.query.period as string) || 'all'
  if (!VALID_PERIODS.includes(period)) {
    res.status(400).json({
      error: `Invalid period. Valid periods: ${VALID_PERIODS.join(', ')}`,
    })
    return
  }
  try {
    const capital = getCapitalAnalytics(period)
    res.json(capital)
  } catch (error) {
    console.error('Error fetching capital analytics:', error)
    res.status(500).json({ error: 'Failed to fetch capital analytics' })
  }
})

analyticsRouter.get('/overview', authenticateApiKey(['read:analytics']), (req, res) => {
  const period = (req.query.period as string) || 'all'
  if (!VALID_PERIODS.includes(period)) {
    res.status(400).json({
      error: `Invalid period. Valid periods: ${VALID_PERIODS.join(', ')}`,
    })
    return
  }
  try {
    const dashboard = period === 'all' ? getOverallAnalytics() : getAnalyticsByPeriod(period)
    const status = getVaultStatusBreakdown()
    const capital = getCapitalAnalytics(period)
    res.json({
      dashboard,
      status,
      capital,
      period,
      generatedAt: utcNow(),
    })
  } catch (error) {
    console.error('Error fetching analytics overview:', error)
    res.status(500).json({ error: 'Failed to fetch analytics overview' })
  }
})
