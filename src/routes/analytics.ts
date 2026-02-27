import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { utcNow } from '../utils/timestamps.js'

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

analyticsRouter.get('/summary', authenticate, (_req, res) => {
  res.status(200).json({
    total_vaults: 10,
    active_vaults: 5,
    completed_vaults: 3,
    failed_vaults: 2,
    total_locked_capital: '5000.0000000',
    active_capital: '2500.0000000',
    success_rate: 60.0,
    last_updated: utcNow(),
  })
})

analyticsRouter.get('/vaults/:id', authenticate, (req, res) => {
  res.status(200).json({
    vault_id: req.params.id,
    status: 'active',
    performance: 'on_track',
  })
})
