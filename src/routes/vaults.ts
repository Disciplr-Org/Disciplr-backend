import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { createValidationMiddleware } from '../middleware/validation/index.js'
import { createVaultSchema, getVaultByIdSchema, vaultsQuerySchema } from '../middleware/validation/schemas.js'

export const vaultsRouter = Router()

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export interface Vault {
  id: string
  creator: string
  amount: string
  startTimestamp: string
  endTimestamp: string
  successDestination: string
  failureDestination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  createdAt: string
}

// In-memory placeholder; replace with DB (e.g. PostgreSQL) later
export let vaults: Array<Vault> = []

export const setVaults = (newVaults: Array<Vault>) => {
  vaults = newVaults
}

vaultsRouter.get(
  '/',
  createValidationMiddleware(vaultsQuerySchema, { source: 'query' }),
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    let result = [...vaults]

    // Apply filters
    if (req.filters) {
      result = applyFilters(result, req.filters)
    }

    // Apply sorting
    if (req.sort) {
      result = applySort(result, req.sort)
    }

    // Apply pagination
    const paginatedResult = paginateArray(result, req.pagination!)

    res.json(paginatedResult)
  }
)

vaultsRouter.post('/', 
  createValidationMiddleware(createVaultSchema, { source: 'body' }),
  (req: Request, res: Response) => {
    const {
      creator,
      amount,
      endTimestamp,
      successDestination,
      failureDestination,
    } = req.body

    const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    const startTimestamp = new Date().toISOString()
    const vault = {
      id,
      creator,
      amount,
      startTimestamp,
      endTimestamp,
      successDestination,
      failureDestination,
      status: 'active' as const,
      createdAt: startTimestamp,
    }
    vaults.push(vault)
    res.status(201).json(vault)
  }
)

vaultsRouter.get('/:id', 
  createValidationMiddleware(getVaultByIdSchema, { source: 'params' }),
  (req: Request, res: Response) => {
    const vault = vaults.find((v) => v.id === req.params.id)
    if (!vault) {
      res.status(404).json({ error: 'Vault not found' })
      return
    }
    res.json(vault)
  }
)
