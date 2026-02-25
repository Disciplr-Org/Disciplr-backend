import pool from '../database.js'
import { Transaction, CreateTransactionRequest, TransactionFilters, TransactionListResponse } from '../types/transactions.js'

export class TransactionService {
  static async createTransaction(data: CreateTransactionRequest): Promise<Transaction> {
    const query = `
      INSERT INTO transactions (userId, vaultId, type, amount, timestamp, stellarHash, link, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *
    `
    
    const values = [
      data.userId,
      data.vaultId,
      data.type,
      data.amount,
      data.timestamp,
      data.stellarHash || null,
      data.link || null,
      data.metadata ? JSON.stringify(data.metadata) : null
    ]

    try {
      const result = await pool.query(query, values)
      return this.mapRowToTransaction(result.rows[0])
    } catch (error) {
      throw new Error(`Failed to create transaction: ${error}`)
    }
  }

  static async createTransactionsBulk(transactions: CreateTransactionRequest[]): Promise<Transaction[]> {
    if (transactions.length === 0) return []

    const query = `
      INSERT INTO transactions (userId, vaultId, type, amount, timestamp, stellarHash, link, metadata)
      VALUES ${transactions.map((_, i) => `($${i * 8 + 1}, $${i * 8 + 2}, $${i * 8 + 3}, $${i * 8 + 4}, $${i * 8 + 5}, $${i * 8 + 6}, $${i * 8 + 7}, $${i * 8 + 8})`).join(', ')}
      RETURNING *
    `

    const values: any[] = []
    transactions.forEach(tx => {
      values.push(
        tx.userId,
        tx.vaultId,
        tx.type,
        tx.amount,
        tx.timestamp,
        tx.stellarHash || null,
        tx.link || null,
        tx.metadata ? JSON.stringify(tx.metadata) : null
      )
    })

    try {
      const result = await pool.query(query, values)
      return result.rows.map(row => this.mapRowToTransaction(row))
    } catch (error) {
      throw new Error(`Failed to create bulk transactions: ${error}`)
    }
  }

  static async getTransactions(
    filters: TransactionFilters,
    page: number = 1,
    limit: number = 50
  ): Promise<TransactionListResponse> {
    const offset = (page - 1) * limit
    const conditions: string[] = []
    const values: any[] = []
    let paramIndex = 1

    // Build WHERE conditions
    if (filters.userId) {
      conditions.push(`userId = $${paramIndex++}`)
      values.push(filters.userId)
    }

    if (filters.type) {
      conditions.push(`type = $${paramIndex++}`)
      values.push(filters.type)
    }

    if (filters.vault) {
      conditions.push(`vaultId = $${paramIndex++}`)
      values.push(filters.vault)
    }

    if (filters.startDate) {
      conditions.push(`timestamp >= $${paramIndex++}`)
      values.push(filters.startDate)
    }

    if (filters.endDate) {
      conditions.push(`timestamp <= $${paramIndex++}`)
      values.push(filters.endDate)
    }

    if (filters.minAmount) {
      conditions.push(`amount >= $${paramIndex++}`)
      values.push(filters.minAmount)
    }

    if (filters.maxAmount) {
      conditions.push(`amount <= $${paramIndex++}`)
      values.push(filters.maxAmount)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM transactions ${whereClause}`
    const countResult = await pool.query(countQuery, values)
    const total = parseInt(countResult.rows[0].total)

    // Get paginated results
    const dataQuery = `
      SELECT * FROM transactions 
      ${whereClause}
      ORDER BY timestamp DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex++}
    `
    values.push(limit, offset)

    const dataResult = await pool.query(dataQuery, values)
    const transactions = dataResult.rows.map(row => this.mapRowToTransaction(row))

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    }
  }

  static async getTransactionById(id: string): Promise<Transaction | null> {
    const query = 'SELECT * FROM transactions WHERE id = $1'
    try {
      const result = await pool.query(query, [id])
      return result.rows[0] ? this.mapRowToTransaction(result.rows[0]) : null
    } catch (error) {
      throw new Error(`Failed to get transaction by ID: ${error}`)
    }
  }

  static async getTransactionsByVaultId(vaultId: string): Promise<Transaction[]> {
    const query = 'SELECT * FROM transactions WHERE vaultId = $1 ORDER BY timestamp DESC'
    try {
      const result = await pool.query(query, [vaultId])
      return result.rows.map(row => this.mapRowToTransaction(row))
    } catch (error) {
      throw new Error(`Failed to get transactions by vault ID: ${error}`)
    }
  }

  static async getTransactionsByUserId(userId: string): Promise<Transaction[]> {
    const query = 'SELECT * FROM transactions WHERE userId = $1 ORDER BY timestamp DESC'
    try {
      const result = await pool.query(query, [userId])
      return result.rows.map(row => this.mapRowToTransaction(row))
    } catch (error) {
      throw new Error(`Failed to get transactions by user ID: ${error}`)
    }
  }

  static async updateTransactionLink(id: string, link: string): Promise<Transaction> {
    const query = 'UPDATE transactions SET link = $1 WHERE id = $2 RETURNING *'
    try {
      const result = await pool.query(query, [link, id])
      if (!result.rows[0]) {
        throw new Error('Transaction not found')
      }
      return this.mapRowToTransaction(result.rows[0])
    } catch (error) {
      throw new Error(`Failed to update transaction link: ${error}`)
    }
  }

  private static mapRowToTransaction(row: any): Transaction {
    return {
      id: row.id,
      userId: row.userId,
      vaultId: row.vaultId,
      type: row.type,
      amount: row.amount.toString(),
      timestamp: row.timestamp.toISOString(),
      stellarHash: row.stellarHash,
      link: row.link,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString()
    }
  }
}
