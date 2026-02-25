import { Router, Request, Response } from 'express'
import { TransactionService } from '../services/transactionService.js'
import { TransactionFilters, TransactionType } from '../types/transactions.js'

export const transactionsRouter = Router()

// GET /api/transactions - List transactions with filters and pagination
transactionsRouter.get('/', async (req: Request, res: Response) => {
  try {
    const {
      type,
      vault,
      startDate,
      endDate,
      minAmount,
      maxAmount,
      userId,
      page = '1',
      limit = '50'
    } = req.query

    // Validate and parse query parameters
    const filters: TransactionFilters = {}
    
    if (type && typeof type === 'string') {
      if (!['creation', 'validation', 'release', 'redirect', 'cancel'].includes(type)) {
        return res.status(400).json({ error: 'Invalid transaction type' })
      }
      filters.type = type as TransactionType
    }

    if (vault && typeof vault === 'string') {
      filters.vault = vault
    }

    if (userId && typeof userId === 'string') {
      filters.userId = userId
    }

    if (startDate && typeof startDate === 'string') {
      const start = new Date(startDate)
      if (isNaN(start.getTime())) {
        return res.status(400).json({ error: 'Invalid startDate format' })
      }
      filters.startDate = start.toISOString()
    }

    if (endDate && typeof endDate === 'string') {
      const end = new Date(endDate)
      if (isNaN(end.getTime())) {
        return res.status(400).json({ error: 'Invalid endDate format' })
      }
      filters.endDate = end.toISOString()
    }

    if (minAmount && typeof minAmount === 'string') {
      const amount = parseFloat(minAmount)
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: 'Invalid minAmount' })
      }
      filters.minAmount = minAmount
    }

    if (maxAmount && typeof maxAmount === 'string') {
      const amount = parseFloat(maxAmount)
      if (isNaN(amount) || amount < 0) {
        return res.status(400).json({ error: 'Invalid maxAmount' })
      }
      filters.maxAmount = maxAmount
    }

    // Parse pagination parameters
    const pageNum = parseInt(page as string)
    const limitNum = parseInt(limit as string)

    if (isNaN(pageNum) || pageNum < 1) {
      return res.status(400).json({ error: 'Invalid page number' })
    }

    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ error: 'Invalid limit (must be between 1 and 100)' })
    }

    const result = await TransactionService.getTransactions(filters, pageNum, limitNum)
    res.json(result)

  } catch (error) {
    console.error('Error fetching transactions:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/transactions/:id - Get a specific transaction by ID
transactionsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    
    if (!id) {
      return res.status(400).json({ error: 'Transaction ID is required' })
    }

    const transaction = await TransactionService.getTransactionById(id)
    
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' })
    }

    res.json(transaction)

  } catch (error) {
    console.error('Error fetching transaction:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/transactions/vault/:vaultId - Get all transactions for a specific vault
transactionsRouter.get('/vault/:vaultId', async (req: Request, res: Response) => {
  try {
    const { vaultId } = req.params
    
    if (!vaultId) {
      return res.status(400).json({ error: 'Vault ID is required' })
    }

    const transactions = await TransactionService.getTransactionsByVaultId(vaultId)
    res.json({ transactions })

  } catch (error) {
    console.error('Error fetching vault transactions:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/transactions/user/:userId - Get all transactions for a specific user
transactionsRouter.get('/user/:userId', async (req: Request, res: Response) => {
  try {
    const { userId } = req.params
    
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' })
    }

    const transactions = await TransactionService.getTransactionsByUserId(userId)
    res.json({ transactions })

  } catch (error) {
    console.error('Error fetching user transactions:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// POST /api/transactions - Create a new transaction (for testing/manual entry)
transactionsRouter.post('/', async (req: Request, res: Response) => {
  try {
    const {
      userId,
      vaultId,
      type,
      amount,
      timestamp,
      stellarHash,
      link,
      metadata
    } = req.body

    // Validate required fields
    if (!userId || !vaultId || !type || !amount || !timestamp) {
      return res.status(400).json({
        error: 'Missing required fields: userId, vaultId, type, amount, timestamp'
      })
    }

    // Validate transaction type
    if (!['creation', 'validation', 'release', 'redirect', 'cancel'].includes(type)) {
      return res.status(400).json({ error: 'Invalid transaction type' })
    }

    // Validate amount
    const amountNum = parseFloat(amount)
    if (isNaN(amountNum) || amountNum < 0) {
      return res.status(400).json({ error: 'Invalid amount' })
    }

    // Validate timestamp
    const timestampDate = new Date(timestamp)
    if (isNaN(timestampDate.getTime())) {
      return res.status(400).json({ error: 'Invalid timestamp format' })
    }

    const transaction = await TransactionService.createTransaction({
      userId,
      vaultId,
      type,
      amount,
      timestamp,
      stellarHash,
      link,
      metadata
    })

    res.status(201).json(transaction)

  } catch (error) {
    console.error('Error creating transaction:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// PUT /api/transactions/:id/link - Update transaction link
transactionsRouter.put('/:id/link', async (req: Request, res: Response) => {
  try {
    const { id } = req.params
    const { link } = req.body

    if (!id) {
      return res.status(400).json({ error: 'Transaction ID is required' })
    }

    if (!link) {
      return res.status(400).json({ error: 'Link is required' })
    }

    const transaction = await TransactionService.updateTransactionLink(id, link)
    res.json(transaction)

  } catch (error) {
    console.error('Error updating transaction link:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/transactions/stats - Get transaction statistics
transactionsRouter.get('/stats', async (req: Request, res: Response) => {
  try {
    const { userId, vaultId } = req.query

    // This would require additional database queries for statistics
    // For now, return a basic response
    res.json({
      message: 'Transaction statistics endpoint - to be implemented',
      filters: { userId, vaultId }
    })

  } catch (error) {
    console.error('Error fetching transaction stats:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})
