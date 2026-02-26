import { Router } from 'express'
import {
  getOverallAnalytics,
  getAnalyticsByPeriod,
  getVaultStatusBreakdown,
  getCapitalAnalytics,
} from '../services/analytics.service.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

export const analyticsRouter = Router()

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
