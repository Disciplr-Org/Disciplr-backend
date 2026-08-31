import { Router, Request, Response, NextFunction } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { encodeCursor, decodeCursor } from '../utils/pagination.js'
import db from '../db/index.js'
import { authenticate } from '../middleware/auth.js'
import {
  TransactionRepository,
  TransactionValidationError,
  TransactionAuthorizationError,
  ALLOWED_TRANSACTION_TYPES,
  clampLimit,
} from '../repositories/transactionRepository.js'

export const transactionsRouter = Router()

// ─── Boundary validation helpers ──────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/
const NETWORK_RE = /^(mainnet|testnet|devnet|futurenet)$/i

export const isValidUUID = (value: string): boolean => typeof value === 'string' && UUID_RE.test(value.trim())

export const requireValidTransactionId = (req: Request, res: Response, next: NextFunction): void => {
  if (!isValidUUID(req.params.id)) {
    res.status(400).json({ error: 'Transaction id must be a valid UUID' })
    return
  }
  next()
}

export const requireValidVaultId = (req: Request, res: Response, next: NextFunction): void => {
  if (!isValidUUID(req.params.vaultId)) {
    res.status(400).json({ error: 'Vault id must be a valid UUID' })
    return
  }
  next()
}

/**
 * Resolves the authenticated actor principal. Disconnected wallet returns null.
 */
export const resolveActorUserId = (req: Request): string | null =>
  req.user?.userId ?? (req as any).apiKeyAuth?.userId ?? null

/**
 * Validates optional wallet and network headers.
 */
export const validateWalletAndNetworkHeaders = (req: Request, res: Response, next: NextFunction): void => {
  const network = req.header('x-network-id')
  if (network && !NETWORK_RE.test(network.trim())) {
    res.status(400).json({ error: 'Invalid network identifier (wrong-network)' })
    return
  }

  const wallet = req.header('x-wallet-address')
  if (wallet && !STELLAR_ADDRESS_RE.test(wallet.trim()) && !ETH_ADDRESS_RE.test(wallet.trim())) {
    res.status(400).json({ error: 'Invalid wallet address format' })
    return
  }

  next()
}

/**
 * Ensures outgoing server responses do not contain NaN, Infinity, or malformed data.
 */
export function assertValidTransactionResponse(data: unknown): void {
  if (data === null || data === undefined) return
  if (typeof data === 'number') {
    if (!Number.isFinite(data) || Number.isNaN(data)) {
      throw new Error('Malformed response: numeric value is not finite')
    }
  } else if (Array.isArray(data)) {
    for (const item of data) {
      assertValidTransactionResponse(item)
    }
  } else if (typeof data === 'object') {
    for (const key of Object.keys(data as Record<string, unknown>)) {
      assertValidTransactionResponse((data as Record<string, unknown>)[key])
    }
  }
}

// GET /api/transactions - Get user's transaction history
transactionsRouter.get(
  '/',
  authenticate,
  validateWalletAndNetworkHeaders,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type', 'stellar_ledger'],
    allowedFilterFields: ['type', 'vault_id', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorUserId(req)
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized: missing or disconnected wallet identity' })
        return
      }

      // Validate filter inputs
      if (req.filters) {
        if (req.filters.type && !ALLOWED_TRANSACTION_TYPES.includes(req.filters.type as any)) {
          res.status(400).json({ error: `Invalid transaction type filter: "${req.filters.type}"` })
          return
        }
        if (req.filters.vault_id && !isValidUUID(req.filters.vault_id)) {
          res.status(400).json({ error: 'vault_id filter must be a valid UUID' })
          return
        }
        if (req.filters.amount_min !== undefined) {
          const min = Number(req.filters.amount_min)
          if (!Number.isFinite(min) || Number.isNaN(min) || min < 0) {
            res.status(400).json({ error: 'amount_min must be a non-negative finite number' })
            return
          }
        }
        if (req.filters.amount_max !== undefined) {
          const max = Number(req.filters.amount_max)
          if (!Number.isFinite(max) || Number.isNaN(max) || max < 0) {
            res.status(400).json({ error: 'amount_max must be a non-negative finite number' })
            return
          }
        }
        if (req.filters.amount_min !== undefined && req.filters.amount_max !== undefined) {
          if (Number(req.filters.amount_min) > Number(req.filters.amount_max)) {
            res.status(400).json({ error: 'amount_min cannot exceed amount_max' })
            return
          }
        }
      }

      let query = db('transactions').where('user_id', userId)

      // Apply filters
      if (req.filters) {
        if (req.filters.type) {
          query = query.where('type', req.filters.type)
        }
        if (req.filters.vault_id) {
          query = query.where('vault_id', req.filters.vault_id)
        }
        if (req.filters.date_from) {
          const dateFrom = Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from
          const d = new Date(String(dateFrom))
          if (isNaN(d.getTime())) {
            res.status(400).json({ error: 'Invalid date_from filter' })
            return
          }
          query = query.where('stellar_timestamp', '>=', d)
        }
        if (req.filters.date_to) {
          const dateTo = Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to
          const d = new Date(String(dateTo))
          if (isNaN(d.getTime())) {
            res.status(400).json({ error: 'Invalid date_to filter' })
            return
          }
          query = query.where('stellar_timestamp', '<=', d)
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

      // Apply pagination (Cursor-based)
      const rawLimit = req.cursorPagination?.limit ? Number(req.cursorPagination.limit) : 20
      const limit = clampLimit(rawLimit)
      const cursor = req.cursorPagination?.cursor

      if (cursor) {
        try {
          const { timestamp, id } = decodeCursor(cursor)
          if (!timestamp || !id || isNaN(new Date(timestamp).getTime())) {
            res.status(400).json({ error: 'Invalid cursor' })
            return
          }
          query = query.where(function () {
            this.where('stellar_timestamp', '<', timestamp).orWhere(function () {
              this.where('stellar_timestamp', '=', timestamp).andWhere('id', '<', id)
            })
          })
        } catch (err) {
          res.status(400).json({ error: 'Invalid cursor' })
          return
        }
      }

      // Enforce stable ordering
      query = query.orderBy('stellar_timestamp', 'desc').orderBy('id', 'desc')

      const transactions = await query.limit(limit + 1).select(
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

      const hasMore = transactions.length > limit
      const results = transactions.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore && results.length > 0) {
        const lastItem = results[results.length - 1]
        nextCursor = encodeCursor(new Date(lastItem.stellar_timestamp), lastItem.id)
      }

      const response = {
        data: results.map((tx) => ({
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
          explorer_url: tx.explorer_url,
        })),
        pagination: {
          limit,
          cursor,
          next_cursor: nextCursor,
          has_more: hasMore,
          count: results.length,
        },
      }

      assertValidTransactionResponse(response)
      res.json(response)
    } catch (error) {
      console.error('Error fetching transactions:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// GET /api/transactions/:id - Get specific transaction
transactionsRouter.get(
  '/:id',
  authenticate,
  validateWalletAndNetworkHeaders,
  requireValidTransactionId,
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorUserId(req)
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized: missing or disconnected wallet identity' })
        return
      }

      const transactionId = req.params.id

      const transaction = await db('transactions')
        .where('id', transactionId)
        .where('user_id', userId)
        .first()

      if (!transaction) {
        res.status(404).json({ error: 'Transaction not found' })
        return
      }

      const response = {
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
        explorer_url: transaction.explorer_url,
      }

      assertValidTransactionResponse(response)
      res.json(response)
    } catch (error) {
      console.error('Error fetching transaction:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

// GET /api/transactions/vault/:vaultId - Get transactions for a specific vault
transactionsRouter.get(
  '/vault/:vaultId',
  authenticate,
  validateWalletAndNetworkHeaders,
  requireValidVaultId,
  queryParser({
    allowedSortFields: ['created_at', 'stellar_timestamp', 'amount', 'type'],
    allowedFilterFields: ['type', 'date_from', 'date_to', 'amount_min', 'amount_max'],
  }),
  async (req: Request, res: Response) => {
    try {
      const userId = resolveActorUserId(req)
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized: missing or disconnected wallet identity' })
        return
      }

      const vaultId = req.params.vaultId

      // Verify user owns the vault or has access via organization
      const vault = await db('vaults')
        .leftJoin('memberships', 'vaults.organization_id', 'memberships.organization_id')
        .where('vaults.id', vaultId)
        .where(function () {
          this.where('vaults.creator', userId).orWhere('memberships.user_id', userId)
        })
        .select('vaults.id')
        .first()

      if (!vault) {
        res.status(404).json({ error: 'Vault not found' })
        return
      }

      // Validate filter inputs
      if (req.filters) {
        if (req.filters.type && !ALLOWED_TRANSACTION_TYPES.includes(req.filters.type as any)) {
          res.status(400).json({ error: `Invalid transaction type filter: "${req.filters.type}"` })
          return
        }
        if (req.filters.amount_min !== undefined) {
          const min = Number(req.filters.amount_min)
          if (!Number.isFinite(min) || Number.isNaN(min) || min < 0) {
            res.status(400).json({ error: 'amount_min must be a non-negative finite number' })
            return
          }
        }
        if (req.filters.amount_max !== undefined) {
          const max = Number(req.filters.amount_max)
          if (!Number.isFinite(max) || Number.isNaN(max) || max < 0) {
            res.status(400).json({ error: 'amount_max must be a non-negative finite number' })
            return
          }
        }
        if (req.filters.amount_min !== undefined && req.filters.amount_max !== undefined) {
          if (Number(req.filters.amount_min) > Number(req.filters.amount_max)) {
            res.status(400).json({ error: 'amount_min cannot exceed amount_max' })
            return
          }
        }
      }

      let query = db('transactions').where('vault_id', vaultId)

      // Apply filters
      if (req.filters) {
        if (req.filters.type) {
          query = query.where('type', req.filters.type)
        }
        if (req.filters.date_from) {
          const dateFrom = Array.isArray(req.filters.date_from) ? req.filters.date_from[0] : req.filters.date_from
          const d = new Date(String(dateFrom))
          if (isNaN(d.getTime())) {
            res.status(400).json({ error: 'Invalid date_from filter' })
            return
          }
          query = query.where('stellar_timestamp', '>=', d)
        }
        if (req.filters.date_to) {
          const dateTo = Array.isArray(req.filters.date_to) ? req.filters.date_to[0] : req.filters.date_to
          const d = new Date(String(dateTo))
          if (isNaN(d.getTime())) {
            res.status(400).json({ error: 'Invalid date_to filter' })
            return
          }
          query = query.where('stellar_timestamp', '<=', d)
        }
        if (req.filters.amount_min) {
          query = query.where('amount', '>=', req.filters.amount_min)
        }
        if (req.filters.amount_max) {
          query = query.where('amount', '<=', req.filters.amount_max)
        }
      }

      // Apply pagination (Cursor-based)
      const rawLimit = req.cursorPagination?.limit ? Number(req.cursorPagination.limit) : 20
      const limit = clampLimit(rawLimit)
      const cursor = req.cursorPagination?.cursor

      if (cursor) {
        try {
          const { timestamp, id } = decodeCursor(cursor)
          if (!timestamp || !id || isNaN(new Date(timestamp).getTime())) {
            res.status(400).json({ error: 'Invalid cursor' })
            return
          }
          query = query.where(function () {
            this.where('stellar_timestamp', '<', timestamp).orWhere(function () {
              this.where('stellar_timestamp', '=', timestamp).andWhere('id', '<', id)
            })
          })
        } catch (err) {
          res.status(400).json({ error: 'Invalid cursor' })
          return
        }
      }

      // Enforce stable ordering
      query = query.orderBy('stellar_timestamp', 'desc').orderBy('id', 'desc')

      const transactions = await query.limit(limit + 1).select(
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

      const hasMore = transactions.length > limit
      const results = transactions.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore && results.length > 0) {
        const lastItem = results[results.length - 1]
        nextCursor = encodeCursor(new Date(lastItem.stellar_timestamp), lastItem.id)
      }

      const response = {
        data: results,
        pagination: {
          limit,
          cursor,
          next_cursor: nextCursor,
          has_more: hasMore,
          count: results.length,
        },
      }

      assertValidTransactionResponse(response)
      res.json(response)
    } catch (error) {
      console.error('Error fetching vault transactions:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  }
)

