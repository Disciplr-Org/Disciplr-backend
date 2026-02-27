import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { vaults } from './vaults.js'

export const orgVaultsRouter = Router()

orgVaultsRouter.get(
  '/:orgId/vaults',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    let result = vaults.filter((v) => v.orgId === orgId)

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
