import { Horizon } from '@stellar/stellar-sdk'
import type { ServerApi } from '@stellar/stellar-sdk'
import { db } from '../db/connection.js'

export interface TransactionRecord {
  id: string
  vault_id: string
  type: 'creation' | 'validation' | 'release' | 'redirect' | 'cancel'
  amount?: string
  timestamp: Date
  stellar_transaction_hash?: string
  stellar_explorer_url?: string
  metadata?: Record<string, any>
}

export interface VaultEvent {
  vault_id: string
  type: 'creation' | 'validation' | 'release' | 'redirect' | 'cancel'
  amount?: string
  timestamp: Date
  transaction_hash?: string
  metadata?: Record<string, any>
}

export class TransactionETLService {
  private horizonServer: Horizon.Server
  private readonly STELLAR_EXPLORER_BASE = 'https://steexp.com/tx'

  constructor(horizonUrl: string = 'https://horizon.stellar.org') {
    this.horizonServer = new Horizon.Server(horizonUrl)
  }

  /**
   * Process vault events from Horizon and store them as transactions
   */
  async processVaultEvents(vaultId: string): Promise<TransactionRecord[]> {
    try {
      const transactions = await this.fetchVaultTransactions(vaultId)
      const processedTransactions = await Promise.all(
        transactions.map(tx => this.mapHorizonEventToTransaction(tx))
      )
      
      await this.saveTransactions(processedTransactions)
      return processedTransactions
    } catch (error) {
      console.error(`Error processing vault events for ${vaultId}:`, error)
      throw error
    }
  }

  /**
   * Fetch all transactions related to a specific vault from Horizon
   */
  async fetchVaultTransactions(vaultId: string): Promise<VaultEvent[]> {
    const events: VaultEvent[] = []
    
    try {
      // Get transactions for the vault account
      const accountTransactions = await this.horizonServer
        .transactions()
        .forAccount(vaultId)
        .order('desc')
        .limit(200)
        .call()

      for (const tx of accountTransactions.records) {
        const vaultEvent = await this.parseTransactionForVault(tx, vaultId)
        if (vaultEvent) {
          events.push(vaultEvent)
        }
      }
    } catch (error) {
      console.error(`Error fetching transactions for vault ${vaultId}:`, error)
      throw error
    }

    return events
  }

  /**
   * Parse a Stellar transaction to extract vault-related events
   */
  private async parseTransactionForVault(
    transaction: ServerApi.TransactionRecord,
    vaultId: string
  ): Promise<VaultEvent | null> {
    try {
      // Get transaction operations to determine the type
      const operations = await transaction.operations()
      
      for (const op of operations.records) {
        if (this.isVaultOperation(op, vaultId)) {
          return {
            vault_id: vaultId,
            type: this.determineOperationType(op),
            amount: this.extractAmount(op),
            timestamp: new Date(transaction.created_at),
            transaction_hash: transaction.hash,
            metadata: {
              operation_id: op.id,
              operation_type: op.type,
              transaction_memo: transaction.memo,
              source_account: transaction.source_account
            }
          }
        }
      }
    } catch (error) {
      console.error(`Error parsing transaction ${transaction.hash}:`, error)
    }

    return null
  }

  /**
   * Check if an operation is related to vault operations
   */
  private isVaultOperation(operation: ServerApi.OperationRecord, vaultId: string): boolean {
    // Check if operation involves the vault account
    return (
      operation.source_account === vaultId ||
      (operation.type === 'payment' && (operation as any).destination === vaultId) ||
      (operation.type === 'create_account' && (operation as any).destination === vaultId)
    )
  }

  /**
   * Determine the type of vault operation based on operation details
   */
  private determineOperationType(operation: ServerApi.OperationRecord): VaultEvent['type'] {
    switch (operation.type) {
      case 'create_account':
        return 'creation'
      case 'payment':
        // Determine if it's validation, release, or redirect based on amount and context
        const payment = operation as any
        if (payment.amount === '0.0000001') { // Small amount for validation
          return 'validation'
        }
        return 'release' // Default to release for payments
      case 'manage_data':
        return 'redirect'
      case 'set_options':
        return 'cancel'
      default:
        return 'creation' // Default fallback
    }
  }

  /**
   * Extract amount from operation
   */
  private extractAmount(operation: ServerApi.OperationRecord): string | undefined {
    if (operation.type === 'payment') {
      return (operation as any).amount
    }
    if (operation.type === 'create_account') {
      return (operation as any).starting_balance
    }
    return undefined
  }

  /**
   * Map Horizon event to transaction record
   */
  async mapHorizonEventToTransaction(event: VaultEvent): Promise<TransactionRecord> {
    const id = `tx-${event.vault_id}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`
    
    return {
      id,
      vault_id: event.vault_id,
      type: event.type,
      amount: event.amount,
      timestamp: event.timestamp,
      stellar_transaction_hash: event.transaction_hash,
      stellar_explorer_url: event.transaction_hash 
        ? `${this.STELLAR_EXPLORER_BASE}/${event.transaction_hash}`
        : undefined,
      metadata: event.metadata
    }
  }

  /**
   * Save transactions to database
   */
  async saveTransactions(transactions: TransactionRecord[]): Promise<void> {
    try {
      await db('transactions').insert(transactions).onConflict().ignore()
    } catch (error) {
      console.error('Error saving transactions:', error)
      throw error
    }
  }

  /**
   * Get transactions from database with filters
   */
  async getTransactions(filters: {
    vaultId?: string
    type?: string
    dateFrom?: string
    dateTo?: string
    amount?: string
    page?: number
    pageSize?: number
  }): Promise<{ transactions: TransactionRecord[]; total: number }> {
    let query = db('transactions').select('*')

    // Apply filters
    if (filters.vaultId) {
      query = query.where('vault_id', filters.vaultId)
    }
    if (filters.type) {
      query = query.where('type', filters.type)
    }
    if (filters.dateFrom) {
      query = query.where('timestamp', '>=', new Date(filters.dateFrom))
    }
    if (filters.dateTo) {
      query = query.where('timestamp', '<=', new Date(filters.dateTo))
    }
    if (filters.amount) {
      query = query.where('amount', filters.amount)
    }

    // Get total count
    const totalQuery = query.clone().clearSelect().clearOrder().count('* as total')
    const [{ total }] = await totalQuery

    // Apply pagination and sorting
    query = query.orderBy('timestamp', 'desc')
    if (filters.page && filters.pageSize) {
      const offset = (filters.page - 1) * filters.pageSize
      query = query.limit(filters.pageSize).offset(offset)
    }

    const transactions = await query
    return { transactions, total: Number(total) }
  }

  /**
   * Get a single transaction by ID
   */
  async getTransactionById(id: string): Promise<TransactionRecord | null> {
    const transaction = await db('transactions').where('id', id).first()
    return transaction || null
  }
}
