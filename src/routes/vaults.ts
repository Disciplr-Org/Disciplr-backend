import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applySort, paginateArray } from '../utils/pagination.js'
import { createVault, listVaults, getVaultById } from '../services/vault.js'

export const vaultsRouter = Router()

vaultsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['created_at', 'amount', 'end_timestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  async (req: Request, res: Response) => {
    const filters = req.filters || {}
    const vaults = await listVaults(filters)

    // applySort and paginateArray are used for local processing if needed, 
    // but listVaults now handles basic filtering/sorting.
    let result = [...vaults]
    if (req.sort) {
      result = applySort(result, req.sort)
    }

    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  }
)

vaultsRouter.post('/', async (req: Request, res: Response) => {
  const {
    creator,
    amount,
    endTimestamp,
    successDestination,
    failureDestination,
  } = req.body as Record<string, string>

  if (!creator || !amount || !endTimestamp || !successDestination || !failureDestination) {
    res.status(400).json({
      error: 'Missing required fields: creator, amount, endTimestamp, successDestination, failureDestination',
    })
    return
  }

  const id = `vault-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
  const startTimestamp = new Date().toISOString()
  
  const vault = await createVault({
    id,
    creator,
    amount,
    start_timestamp: startTimestamp,
    end_timestamp: endTimestamp,
    success_destination: successDestination,
    failure_destination: failureDestination,
    status: 'active',
  })

  res.status(201).json(vault)
})

vaultsRouter.get('/:id', async (req: Request, res: Response) => {
  const vault = await getVaultById(req.params.id)
  if (!vault) {
    res.status(404).json({ error: 'Vault not found' })
    return
  }
  res.json(vault)
})
