import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { db } from '../db/index.js'
import { requireUserAuth } from '../middleware/userAuth.js'

export const transactionsRouter = Router()

// GET /api/transactions - Get user's transaction history
transactionsRouter.get(
  '/',
  requireUserAuth,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type', 'stellar_ledger'],
    allowedFilterFields: ['type', 'vault_id', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.authUser!.userId
      let query = db('transactions').where('user_id', userId)

      // Apply filters
      if (req.filters) {
        // Type filter
        if (req.filters.type) {
          query = query.where('type', req.filters.type)
        }

        // Vault ID filter
        if (req.filters.vault_id) {
          query = query.where('vault_id', req.filters.vault_id)
        }

        // Date range filters
        if (req.filters.date_from) {
          const dateFrom = Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from
          query = query.where('stellar_timestamp', '>=', new Date(dateFrom))
        }
        if (req.filters.date_to) {
          const dateTo = Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to
          query = query.where('stellar_timestamp', '<=', new Date(dateTo))
        }

        // Amount range filters
        if (req.filters.amount_min) {
          query = query.where('amount', '>=', req.filters.amount_min)
        }
        if (req.filters.amount_max) {
          query = query.where('amount', '<=', req.filters.amount_max)
        }
      }

      // Apply sorting
      if (req.sort) {
        const sortField = req.sort.sortBy || 'stellar_timestamp'
        const sortDirection = req.sort.sortOrder === 'desc' ? 'desc' : 'asc'
        query = query.orderBy(sortField, sortDirection)
      } else {
        // Default sort: newest first
        query = query.orderBy('stellar_timestamp', 'desc')
      }

      // Get total count for pagination
      const totalCount = await query.clone().count('* as total').first()
      const total = parseInt(String(totalCount?.total || '0'))

      // Apply pagination
      const limit = parseInt(String(req.pagination?.pageSize || '20'))
      const offset = (parseInt(String(req.pagination?.page || '1')) - 1) * limit
      
      query = query.limit(limit).offset(offset)

      const transactions = await query.select(
        'id',
        'vault_id',
        'type',
        'amount',
        'asset_code',
        'tx_hash',
        'from_account',
        'to_account',
        'memo',
        'created_at',
        'stellar_ledger',
        'stellar_timestamp',
        'explorer_url'
      )

      const response = {
        data: transactions.map(tx => ({
          id: tx.id,
          vault_id: tx.vault_id,
          type: tx.type,
          amount: tx.amount,
          asset_code: tx.asset_code,
          tx_hash: tx.tx_hash,
          from_account: tx.from_account,
          to_account: tx.to_account,
          memo: tx.memo,
          created_at: tx.created_at,
          stellar_ledger: tx.stellar_ledger,
          stellar_timestamp: tx.stellar_timestamp,
          explorer_url: tx.explorer_url
        })),
        pagination: {
          limit,
          offset,
          total,
          has_more: offset + limit < total,
          page: Math.floor(offset / limit) + 1,
          pageSize: limit
        }
      }

      res.json(response)
    } catch (error) {
      console.error('Error fetching transactions:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// GET /api/transactions/:id - Get specific transaction
transactionsRouter.get('/:id', requireUserAuth, async (req: Request, res: Response) => {
  try {
    const userId = req.authUser!.userId
    const transactionId = req.params.id

    const transaction = await db('transactions')
      .where('id', transactionId)
      .where('user_id', userId)
      .first()

    if (!transaction) {
      res.status(404).json({ error: 'Transaction not found' })
      return
    }

    res.json({
      id: transaction.id,
      vault_id: transaction.vault_id,
      type: transaction.type,
      amount: transaction.amount,
      asset_code: transaction.asset_code,
      tx_hash: transaction.tx_hash,
      from_account: transaction.from_account,
      to_account: transaction.to_account,
      memo: transaction.memo,
      created_at: transaction.created_at,
      stellar_ledger: transaction.stellar_ledger,
      stellar_timestamp: transaction.stellar_timestamp,
      explorer_url: transaction.explorer_url
    })
  } catch (error) {
    console.error('Error fetching transaction:', error)
    res.status(500).json({ error: 'Internal server error' })
  }
})

// GET /api/transactions/vault/:vaultId - Get transactions for a specific vault
transactionsRouter.get(
  '/vault/:vaultId',
  requireUserAuth,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type'],
    allowedFilterFields: ['type', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = req.authUser!.userId
      const vaultId = req.params.vaultId

      // Verify user owns the vault
      const vault = await db('vaults')
        .where('id', vaultId)
        .where('user_id', userId)
        .first()

      if (!vault) {
        res.status(404).json({ error: 'Vault not found' })
        return
      }

      let query = db('transactions')
        .where('user_id', userId)
        .where('vault_id', vaultId)

      // Apply filters (same as main endpoint)
      if (req.filters) {
        if (req.filters.type) {
          query = query.where('type', req.filters.type)
        }
        if (req.filters.date_from) {
          const dateFrom = Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from
          query = query.where('stellar_timestamp', '>=', new Date(dateFrom))
        }
        if (req.filters.date_to) {
          const dateTo = Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to
          query = query.where('stellar_timestamp', '<=', new Date(dateTo))
        }
        if (req.filters.amount_min) {
          query = query.where('amount', '>=', req.filters.amount_min)
        }
        if (req.filters.amount_max) {
          query = query.where('amount', '<=', req.filters.amount_max)
        }
      }

      // Apply sorting
      if (req.sort) {
        const sortField = req.sort.sortBy || 'stellar_timestamp'
        const sortDirection = req.sort.sortOrder === 'desc' ? 'desc' : 'asc'
        query = query.orderBy(sortField, sortDirection)
      } else {
        query = query.orderBy('stellar_timestamp', 'desc')
      }

      const transactions = await query.select(
        'id',
        'vault_id',
        'type',
        'amount',
        'asset_code',
        'tx_hash',
        'from_account',
        'to_account',
        'memo',
        'created_at',
        'stellar_ledger',
        'stellar_timestamp',
        'explorer_url'
      )

      res.json({
        data: transactions,
        pagination: {
          total: transactions.length,
          has_more: false
        }
      })
    } catch (error) {
      console.error('Error fetching vault transactions:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)
