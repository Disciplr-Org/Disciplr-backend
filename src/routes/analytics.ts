


import { Router, Request, Response } from 'express'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { db } from '../services/knex.js'

export const analyticsRouter = Router()

// ── Helpers ──────────────────────────────────────────────────────────────────

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