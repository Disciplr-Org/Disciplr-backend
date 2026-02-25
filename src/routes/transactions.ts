import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'

export const transactionsRouter = Router()

// In-memory placeholder
const transactions: Array<{
  id: string
  vaultId: string
  type: 'deposit' | 'withdrawal' | 'milestone'
  amount: string
  timestamp: string
  status: 'pending' | 'completed' | 'failed'
}> = []

transactionsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['timestamp', 'amount', 'type', 'status'],
    allowedFilterFields: ['vaultId', 'type', 'status'],
  }),
  (req: Request, res: Response) => {
    let result = [...transactions]

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

transactionsRouter.get('/:id', (req: Request, res: Response) => {
  const transaction = transactions.find((t) => t.id === req.params.id)
  if (!transaction) {
    res.status(404).json({ error: 'Transaction not found' })
    return
  }
  res.json(transaction)
})
