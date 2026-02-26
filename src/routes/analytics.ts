<<<<<<< HEAD
import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
=======
import { Router } from 'express'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

export const analyticsRouter = Router()
import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { utcNow } from '../utils/timestamps.js'
import { Router } from 'express'
>>>>>>> upstream/main
import {
  getOverallAnalytics,
  getAnalyticsByPeriod,
  getVaultStatusBreakdown,
  getCapitalAnalytics,
} from '../services/analytics.service.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

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

<<<<<<< HEAD
=======
analyticsRouter.get('/overview', authenticateApiKey(['read:analytics']), (_req, res) => {
  res.json({
    metrics: {
      activeVaults: 4,
      completedVaults: 12,
      totalValueLocked: '42000',
    },
    generatedAt: utcNow(),
  })
})

>>>>>>> upstream/main
analyticsRouter.get('/vaults', authenticateApiKey(['read:vaults']), (_req: Request, res: Response) => {
  res.json({
    metrics: {
      totalVaults: 16,
      activeVaults: 4,
      completionRate: 0.75,
    },
    generatedAt: utcNow(),
  })
}) // Fixed missing closing braces

// Valid time periods
const VALID_PERIODS = ['7d', '30d', '90d', '1y', 'all']

/**
 * GET /api/analytics/dashboard
 * Get overall dashboard metrics (all-time)
 */
analyticsRouter.get('/dashboard', authenticateApiKey(['read:analytics']), (_req, res) => {
  try {
    const analytics = getOverallAnalytics()
    res.json(analytics)
  } catch (error) {
    console.error('Error fetching dashboard analytics:', error)
    res.status(500).json({ error: 'Failed to fetch dashboard analytics' })
  }
})

/**
 * GET /api/analytics/dashboard/:period
 * Get dashboard metrics for a specific time period
 * Valid periods: 7d, 30d, 90d, 1y
 */
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

/**
 * GET /api/analytics/status
 * Get vault status breakdown
 */
analyticsRouter.get('/status', authenticateApiKey(['read:analytics']), (_req, res) => {
  try {
    const breakdown = getVaultStatusBreakdown()
    res.json(breakdown)
  } catch (error) {
    console.error('Error fetching status breakdown:', error)
    res.status(500).json({ error: 'Failed to fetch status breakdown' })
  }
})

/**
 * GET /api/analytics/capital
 * Get capital analytics
 * Query params: period (optional, default: all)
 */
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

/**
 * GET /api/analytics/overview
 * Get complete analytics overview with all metrics
 * Query params: period (optional, default: all)
 */
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
    })
  } catch (error) {
    console.error('Error fetching analytics overview:', error)
    res.status(500).json({ error: 'Failed to fetch analytics overview' })
  }
})

// I will assume listMilestoneEvents doesn't exist natively but there were no conflicts on the remainder of the file, let me double check the bottom chunk. Wait! 
