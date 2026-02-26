import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { TransactionETLService, TransactionRecord } from '../services/transactions.js'

export const transactionsRouter = Router()
const transactionETL = new TransactionETLService()

// GET /transactions - List transactions with filters
transactionsRouter.get(
  '/',
  queryParser({
    allowedSortFields: ['timestamp', 'amount', 'type'],
    allowedFilterFields: ['vaultId', 'type', 'dateFrom', 'dateTo', 'amount'],
  }),
  async (req: Request, res: Response) => {
    try {
      const filters = {
        vaultId: req.filters?.vaultId as string,
        type: req.filters?.type as string,
        dateFrom: req.filters?.dateFrom as string,
        dateTo: req.filters?.dateTo as string,
        amount: req.filters?.amount as string,
        page: req.pagination?.page,
        pageSize: req.pagination?.pageSize,
      }

      const result = await transactionETL.getTransactions(filters)
      
      res.json({
        data: result.transactions,
        pagination: {
          page: req.pagination?.page,
          pageSize: req.pagination?.pageSize,
          total: result.total,
        }
      })
    } catch (error) {
      console.error('Error fetching transactions:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// GET /transactions/:id - Get single transaction
transactionsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const transaction = await transactionETL.getTransactionById(req.params.id)
    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' })
      return
    }
    res.json(transaction)
  } catch (error) {
    console.error('Error fetching transaction:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /transactions/sync/:vaultId - Sync transactions for a specific vault
transactionsRouter.post('/sync/:vaultId', async (req: Request, res: Response) => {
  try {
    const transactions = await transactionETL.processVaultEvents(req.params.vaultId)
    res.json({
      message: `Synced ${transactions.length} transactions for vault ${req.params.vaultId}`,
      data: transactions
    })
  } catch (error) {
    console.error('Error syncing vault transactions:', error)
    res.status(500).json({ error: 'Failed to sync vault transactions' })
  }
})
