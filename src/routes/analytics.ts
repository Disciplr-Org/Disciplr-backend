import { Router } from 'express'
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

analyticsRouter.get('/overview', authenticateApiKey(['read:analytics']), (_req, res) => {
  res.json({
    metrics: {
      activeVaults: 4,
      completedVaults: 12,
      totalValueLocked: '42000',
    },
    generatedAt: new Date().toISOString(),
  })
})

analyticsRouter.get('/vaults', authenticateApiKey(['read:vaults']), (_req: Request, res: Response) => {
  res.json({
    metrics: {
      totalVaults: 16,
      activeVaults: 4,
      completionRate: 0.75,
    },
    generatedAt: new Date().toISOString(),
  })
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

analyticsRouter.get(
  '/milestones/trends',
  authenticateApiKey(['read:analytics']),
  (req: Request, res: Response) => {
    const from = req.query.from as string | undefined
    const to = req.query.to as string | undefined
    const groupBy = (req.query.groupBy as string | undefined) ?? 'day'
    const userId = req.query.userId as string | undefined

    const validGroups = new Set(['day', 'week', 'month'])
    if (!validGroups.has(groupBy)) {
      res.status(400).json({ error: 'groupBy must be one of: day, week, month' })
      return
    }

    const events = listMilestoneEvents({ userId, from, to })
    const buckets = new Map<string, { periodStart: string; success: number; failed: number; total: number }>()

    for (const e of events) {
      const d = new Date(e.timestamp)
      const periodStart = startOfPeriodUtc(d, groupBy as 'day' | 'week' | 'month').toISOString()
      const current = buckets.get(periodStart) ?? { periodStart, success: 0, failed: 0, total: 0 }
      if (e.status === 'success') current.success += 1
      if (e.status === 'failed') current.failed += 1
      current.total += 1
      buckets.set(periodStart, current)
    }

    const data = Array.from(buckets.values()).sort(
      (a, b) => new Date(a.periodStart).getTime() - new Date(b.periodStart).getTime()
    )

    res.json({ buckets: data, generatedAt: new Date().toISOString(), groupBy })
  }
)

analyticsRouter.get('/behavior', authenticateApiKey(['read:analytics']), (req: Request, res: Response) => {
  const userId = (req.query.userId as string | undefined)?.trim()
  if (!userId) {
    res.status(400).json({ error: 'userId is required' })
    return
  }

  const windowDays = parseInt((req.query.windowDays as string) ?? '30', 10)
  const baseScorePerSuccess = Number((req.query.baseScorePerSuccess as string) ?? '5')
  const penaltyPerFailure = Number((req.query.penaltyPerFailure as string) ?? '2')
  const streakBonusPerDay = Number((req.query.streakBonusPerDay as string) ?? '1')

  const now = new Date()
  const start = new Date(now)
  start.setUTCDate(now.getUTCDate() - Math.max(0, windowDays - 1))
  start.setUTCHours(0, 0, 0, 0)

  const events = listMilestoneEvents({ userId, from: start.toISOString(), to: now.toISOString() })

  const successes = events.filter((e) => e.status === 'success').length
  const failures = events.filter((e) => e.status === 'failed').length

  const successDays = new Set(
    events.filter((e) => e.status === 'success').map((e) => startOfPeriodUtc(new Date(e.timestamp), 'day').toISOString())
  )

  let streakDays = 0
  let cursor = new Date(now)
  cursor.setUTCHours(0, 0, 0, 0)
  while (cursor >= start) {
    const key = cursor.toISOString()
    if (!successDays.has(key)) break
    streakDays += 1
    cursor.setUTCDate(cursor.getUTCDate() - 1)
  }

  const behaviorScore = successes * baseScorePerSuccess - failures * penaltyPerFailure + streakDays * streakBonusPerDay

  res.json({
    userId,
    window: { from: start.toISOString(), to: now.toISOString(), days: windowDays },
    metrics: { successes, failures, streakDays },
    behaviorScore,
    weights: { baseScorePerSuccess, penaltyPerFailure, streakBonusPerDay },
    generatedAt: new Date().toISOString(),
  })
})

function startOfPeriodUtc(date: Date, groupBy: 'day' | 'week' | 'month'): Date {
  const d = new Date(date)
  if (groupBy === 'day') {
    d.setUTCHours(0, 0, 0, 0)
    return d
  }
  if (groupBy === 'week') {
    d.setUTCHours(0, 0, 0, 0)
    const day = d.getUTCDay()
    const diffToMonday = (day + 6) % 7
    d.setUTCDate(d.getUTCDate() - diffToMonday)
    return d
  }
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(1)
  return d
}
