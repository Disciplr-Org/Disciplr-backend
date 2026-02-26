

import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { db } from '../services/knex.js'
import { utcNow } from '../utils/timestamps.js'
import {
  getOverallAnalytics,
  getAnalyticsByPeriod,
  getVaultStatusBreakdown,
  getCapitalAnalytics,
} from '../services/analytics.service.js'
import { listMilestoneEvents } from '../services/milestones.js'
export const analyticsRouter = Router()

const analyticsViews: Array<{
  id: string
  vaultId: string
  metric: string
  value: number
  timestamp: string
  period: 'daily' | 'weekly' | 'monthly'
}> = []

/** Refresh both materialized views. Call from a background job or on-demand. */
export async function refreshAnalyticsViews(): Promise<void> {
  await db.raw('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_vault_performance')
  await db.raw('REFRESH MATERIALIZED VIEW CONCURRENTLY analytics.mv_user_behavioral_scores')
}

// ── GET /analytics/overview ───────────────────────────────────────────────────
/**
 * High-level platform snapshot.
 * Reads from the analytics.vault_lifecycle_summary table which is kept
 * current by the analytics ETL / event listeners.
 *
 * Ownership: analytics schema (read-only from route layer).
 */
analyticsRouter.get(
  '/',
  authenticateApiKey(['read:analytics']),
  async (_req: Request, res: Response) => {
    try {
      const [row] = await db('analytics.vault_lifecycle_summary')
        .select(
          db.raw('COUNT(*) AS "totalVaults"'),
          db.raw(`COUNT(*) FILTER (WHERE status = 'active')  AS "activeVaults"`),
          db.raw(`COUNT(*) FILTER (WHERE status = 'completed') AS "completedVaults"`),
          db.raw('COALESCE(SUM(current_tvl), 0)::text AS "totalValueLocked"'),
        )

      const completionRate =
        Number(row.totalVaults) > 0
          ? Number(row.completedVaults) / Number(row.totalVaults)
          : 0

      res.json({
        metrics: {
          totalVaults: Number(row.totalVaults),
          activeVaults: Number(row.activeVaults),
          completedVaults: Number(row.completedVaults),
          totalValueLocked: row.totalValueLocked,
          completionRate: parseFloat(completionRate.toFixed(4)),
        },
        generatedAt: new Date().toISOString(),
      })
    } catch (err) {
      console.error('[analytics/overview]', err)
      res.status(500).json({ error: 'Failed to fetch overview metrics' })
    }
  },
)

// ── GET /analytics/vaults ─────────────────────────────────────────────────────
/**
 * Paginated vault performance list from the materialized view.
 * Supports filtering by status, sorting by capital metrics.
 *
 * Query params (via queryParser middleware):
 *   filter[status]  – vault status
 *   filter[creator] – creator_address substring match
 *   sort            – field name (prefix '-' for DESC)
 *   page / pageSize
 */
analyticsRouter.get(
  '/vaults',
  authenticateApiKey(['read:vaults']),
  queryParser({
    allowedSortFields: [
      'created_at',
      'current_tvl',
      'total_deposited',
      'completion_rate',
      'capital_efficiency_score',
      'active_duration_seconds',
    ],
    allowedFilterFields: ['status', 'creator_address'],
  }),
  async (req: Request, res: Response) => {
    try {
      let query = db('analytics.mv_vault_performance').select('*')

      // Apply server-side filters where possible
      if (req.filters) {
        for (const [field, value] of Object.entries(req.filters)) {
          if (field === 'status') query = query.where('status', value as string)
          if (field === 'creator_address')
            query = query.whereILike('creator_address', `%${value}%`)
        }
      }

      const rows = await query.orderBy('created_at', 'desc')

      // Delegate additional in-memory sort/filter/pagination to utils
      let result = rows as Record<string, unknown>[]
      if (req.sort) result = applySort(result, req.sort)
      const paginatedResult = paginateArray(result, req.pagination!)

      res.json(paginatedResult)
    } catch (err) {
      console.error('[analytics/vaults]', err)
      res.status(500).json({ error: 'Failed to fetch vault analytics' })
    }
  },
)

// ── GET /analytics/vaults/:vaultId ───────────────────────────────────────────
/**
 * Single vault detail: lifecycle summary + milestone breakdown + capital flow.
 */
analyticsRouter.get(
  '/vaults/:vaultId',
  authenticateApiKey(['read:vaults']),
  async (req: Request, res: Response) => {
    const { vaultId } = req.params

    try {
      const [summary, milestones, recentFlows] = await Promise.all([
        db('analytics.vault_lifecycle_summary').where({ vault_id: vaultId }).first(),

        db('analytics.milestone_performance')
          .where({ vault_id: vaultId })
          .orderBy('milestone_index', 'asc'),

        db('analytics.capital_flow')
          .where({ vault_id: vaultId })
          .orderBy('occurred_at', 'desc')
          .limit(50),
      ])

      if (!summary) {
        return res.status(404).json({ error: 'Vault not found in analytics store' })
      }

      res.json({ summary, milestones, recentFlows })
    } catch (err) {
      console.error('[analytics/vaults/:vaultId]', err)
      res.status(500).json({ error: 'Failed to fetch vault detail' })
    }
  },
)

// ── GET /analytics/capital-flow ───────────────────────────────────────────────
/**
 * Aggregated capital flow report, grouped by period and flow type.
 *
 * Query params:
 *   vaultId   – filter to a single vault
 *   period    – 'daily' | 'weekly' | 'monthly' (default: daily)
 *   from      – ISO date string (inclusive)
 *   to        – ISO date string (inclusive)
 */
analyticsRouter.get(
  '/capital-flow',
  authenticateApiKey(['read:analytics']),
  async (req: Request, res: Response) => {
    const { vaultId, period = 'daily', from, to } = req.query as Record<string, string>

    // Map period param to the DB column
    const periodCol: Record<string, string> = {
      daily: 'period_date',
      weekly: 'period_week',
      monthly: 'period_month',
    }
    const groupCol = periodCol[period] ?? 'period_date'

    try {
      let query = db('analytics.capital_flow')
        .select(
          db.raw(`${groupCol} AS period`),
          'flow_type',
          db.raw('SUM(amount)::text AS total_amount'),
          db.raw('COUNT(*) AS event_count'),
          db.raw('COUNT(DISTINCT user_address) AS unique_users'),
        )
        .groupBy(groupCol, 'flow_type')
        .orderBy(groupCol, 'desc')

      if (vaultId) query = query.where({ vault_id: vaultId })
      if (from) query = query.where('occurred_at', '>=', new Date(from))
      if (to) query = query.where('occurred_at', '<=', new Date(to))

      const rows = await query
      res.json({ period, data: rows })
    } catch (err) {
      console.error('[analytics/capital-flow]', err)
      res.status(500).json({ error: 'Failed to fetch capital flow' })
    }
  },
)

// ── GET /analytics/users ──────────────────────────────────────────────────────
/**
 * Paginated user behavioral score leaderboard.
 * Reads from mv_user_behavioral_scores materialized view.
 */
analyticsRouter.get(
  '/users',
  authenticateApiKey(['read:analytics']),
  queryParser({
    allowedSortFields: [
      'overall_behavioral_score',
      'total_deposited_lifetime',
      'vaults_completed',
      'last_activity_at',
    ],
    allowedFilterFields: ['user_address'],
  }),
  async (req: Request, res: Response) => {
    try {
      let query = db('analytics.mv_user_behavioral_scores')
        .select('*')
        .orderBy('overall_behavioral_score', 'desc')

      if (req.filters?.user_address) {
        query = query.whereILike('user_address', `%${req.filters.user_address}%`)
      }

      const rows = await query
      let result = rows as Record<string, unknown>[]
      if (req.sort) result = applySort(result, req.sort)
      const paginatedResult = paginateArray(result, req.pagination!)

      res.json(paginatedResult)
    } catch (err) {
      console.error('[analytics/users]', err)
      res.status(500).json({ error: 'Failed to fetch user analytics' })
    }
  },
)

// ── GET /analytics/users/:userAddress ────────────────────────────────────────
/**
 * Full analytics profile for a single user.
 */
analyticsRouter.get(
  '/users/:userAddress',
  authenticateApiKey(['read:analytics']),
  async (req: Request, res: Response) => {
    const { userAddress } = req.params

    try {
      const [aggregate, flowSummary] = await Promise.all([
        db('analytics.user_aggregates').where({ user_address: userAddress }).first(),

        db('analytics.capital_flow')
          .where({ user_address: userAddress })
          .select(
            'flow_type',
            db.raw('SUM(amount)::text AS total_amount'),
            db.raw('COUNT(*) AS event_count'),
          )
          .groupBy('flow_type'),
      ])

      if (!aggregate) {
        return res.status(404).json({ error: 'User not found in analytics store' })
      }

      res.json({ aggregate, flowSummary })
    } catch (err) {
      console.error('[analytics/users/:userAddress]', err)
      res.status(500).json({ error: 'Failed to fetch user detail' })
    }
  },
)
analyticsRouter.get(
  '/views',
  authenticateApiKey(['read:analytics']),
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
  },
)

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
