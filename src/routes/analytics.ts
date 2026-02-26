import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

export const analyticsRouter = Router()

// In-memory placeholder
const analyticsViews: Array<{
  id: string
  vaultId: string
  metric: string
  value: number
  timestamp: string
  period: 'daily' | 'weekly' | 'monthly'
}> = []

/**
 * @swagger
 * /api/analytics:
 *   get:
 *     summary: Get analytics metrics
 *     description: Retrieve analytics metrics with optional filtering and sorting
 *     tags: [Analytics]
 *     security:
 *       - bearerAuth: []
 *       - apiKeyAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 10
 *         description: Number of items per page
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [timestamp, value, metric]
 *         description: Field to sort by
 *       - in: query
 *         name: order
 *         schema:
 *           type: string
 *           enum: [asc, desc]
 *           default: desc
 *         description: Sort order
 *       - in: query
 *         name: vaultId
 *         schema:
 *           type: string
 *         description: Filter by vault ID
 *       - in: query
 *         name: metric
 *         schema:
 *           type: string
 *         description: Filter by metric type
 *       - in: query
 *         name: period
 *         schema:
 *           type: string
 *           enum: [daily, weekly, monthly]
 *         description: Filter by time period
 *     responses:
 *       200:
 *         description: Analytics metrics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/analytics/overview:
 *   get:
 *     summary: Get analytics overview
 *     description: Retrieve overview metrics for the platform
 *     tags: [Analytics]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Overview metrics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metrics:
 *                   type: object
 *                   properties:
 *                     activeVaults:
 *                       type: integer
 *                       example: 4
 *                     completedVaults:
 *                       type: integer
 *                       example: 12
 *                     totalValueLocked:
 *                       type: string
 *                       example: '42000'
 *                 generatedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
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

/**
 * @swagger
 * /api/analytics/vaults:
 *   get:
 *     summary: Get vault analytics
 *     description: Retrieve vault-specific analytics metrics
 *     tags: [Analytics]
 *     security:
 *       - apiKeyAuth: []
 *     responses:
 *       200:
 *         description: Vault analytics retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 metrics:
 *                   type: object
 *                   properties:
 *                     totalVaults:
 *                       type: integer
 *                       example: 16
 *                     activeVaults:
 *                       type: integer
 *                       example: 4
 *                     completionRate:
 *                       type: number
 *                       example: 0.75
 *                 generatedAt:
 *                   type: string
 *                   format: date-time
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
analyticsRouter.get('/vaults', authenticateApiKey(['read:vaults']), (_req, res) => {
  res.json({
    metrics: {
      totalVaults: 16,
      activeVaults: 4,
      completionRate: 0.75,
    },
    generatedAt: new Date().toISOString(),
  })
})
