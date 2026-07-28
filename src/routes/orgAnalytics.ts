import { orgAnalyticsRateLimiter } from '../middleware/rateLimiter.js'
import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { getOrgRiskAnalytics, getOverallAnalytics } from '../services/analytics.service.js'
import { vaults } from './vaults.js'
import { db } from '../db/knex.js'
import { getOrgReports } from '../services/analyticsReports.js'

export const orgAnalyticsRouter = Router()

const paginateArray = <T>(arr: T[], pagination: { page: number; pageSize: number }): { data: T[]; total: number; page: number; pageSize: number } => {
  const start = (pagination.page - 1) * pagination.pageSize
  return { data: arr.slice(start, start + pagination.pageSize), total: arr.length, ...pagination }
}

const resolveS3Config = (): null => null
const getExportSignedUrl = async (_config: null, _s3Key: string): Promise<string> => { throw new Error('S3 not configured') }
const getCohortRetention = async (_db: unknown, _range?: number): Promise<unknown[]> => []

const requireOrgRole = (roles: string[]) => (req: Request, res: Response, next: NextFunction) => {
  requireOrgAccess(...(roles as ['owner' | 'admin']))(req, res, next)
}

// Stub functions for unimplemented endpoints
const listOrgVaultsForRiskAnalytics = async (_orgId: string): Promise<unknown[]> => []
const getOrgAnalytics = async (_orgId: string): Promise<unknown> => getOverallAnalytics()
const getTeamRollup = async (_orgId: string): Promise<unknown> => ({ teams: [] })

const parsePaginationParams = (req: Request): { page: number; pageSize: number } => ({
  page: Math.max(1, parseInt(req.query.page as string, 10) || 1),
  pageSize: Math.min(100, Math.max(1, parseInt(req.query.pageSize as string, 10) || 20)),
})

orgAnalyticsRouter.get(
  '/:orgId/analytics/risk',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined

    try {
      const result = getOrgRiskAnalytics(orgId, vaults as any, { startDate, endDate })
      res.json(result)
    } catch (error: any) {
      res.status(400).json({ error: error.message })
    }
  }
)

orgAnalyticsRouter.get(
  '/:orgId/analytics',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params
    const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : undefined
    const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : undefined

    try {
      const v = await listOrgVaultsForRiskAnalytics(orgId) as any
      const result = getOrgRiskAnalytics(orgId, v, { startDate, endDate })
      res.json(result)
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to generate risk analytics'
      res.status(400).json({ error: message })
    }
  },
)

orgAnalyticsRouter.get(
  '/:orgId/analytics/overview',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params

    try {
      const analytics = await getOrgAnalytics(orgId)
      res.json(analytics)
    } catch {
      res.status(500).json({ error: 'Failed to generate org analytics' })
    }
  },
)

orgAnalyticsRouter.get(
  '/:orgId/cohort-retention',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const range = req.query.range ? parseInt(req.query.range as string, 10) : undefined
      const data = await getCohortRetention(db, range)

      res.status(200).json({ success: true, orgId: req.params.orgId, data })
    } catch (error) {
      next(error)
    }
  },
)

orgAnalyticsRouter.get(
  '/:orgId/teams/rollup',
  authenticate,
  requireOrgRole(['owner', 'admin']),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params

    try {
      const rollup = await getTeamRollup(orgId)
      res.json(rollup)
    } catch {
      res.status(500).json({ error: 'Failed to generate team rollup' })
    }
  },
)

orgAnalyticsRouter.get(
  '/:orgId/analytics/reports',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params
    const pagination = parsePaginationParams(req)

    const result = await getOrgReports(orgId)
    const items = result.data.map((r) => ({
      id: r.id,
      orgId: r.orgId,
      snapshotAt: r.snapshotAt,
      createdAt: r.createdAt,
      sizeBytes: r.sizeBytes,
      downloadUrl: r.localBuffer ? `/api/orgs/${orgId}/analytics/reports/${r.id}/download` : null,
    }))

    res.json({ data: items, total: result.total, page: pagination.page, pageSize: pagination.pageSize })
  },
)
