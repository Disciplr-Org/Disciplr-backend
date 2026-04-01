import { Horizon } from '@stellar/stellar-sdk'
import type { Transaction, HorizonOperation, ETLConfig, VaultReference } from '../types/transactions.js'
import { db } from '../db/index.js'

export class TransactionETLService {
  private server: Horizon.Server
  private config: ETLConfig
  private readonly STELLAR_EXPLORER_BASE = 'https://stellar.expert/explorer/public/tx'

  constructor(config: ETLConfig) {
    this.config = config
    this.server = new Horizon.Server(config.horizonUrl)
  }

  /**
   * Run the full ETL process - backfill and incremental sync.
   * Pass an AbortSignal to allow the caller to cancel a long-running run.
   */
  async runETL(signal?: AbortSignal): Promise<void> {
    TransactionETLService.checkAbort(signal)
    console.log('Starting Transaction ETL process...')

    try {
      // Run backfill if configured
      if (this.config.backfillFrom) {
        await this.backfillHistoricalTransactions(signal)
      }

      TransactionETLService.checkAbort(signal)

      // Run incremental sync
      await this.incrementalSync(signal)

      console.log('ETL process completed successfully')
    } catch (error) {
      if (TransactionETLService.isAbortError(error)) {
        console.log('ETL process aborted')
        throw error
      }
      console.error('ETL process failed:', error)
      throw error
    }
  }

  /**
   * Backfill historical transactions from a date range
   */
  async backfillHistoricalTransactions(signal?: AbortSignal): Promise<void> {
    console.log(`Starting backfill from ${this.config.backfillFrom} to ${this.config.backfillTo}`)

    const from = this.config.backfillFrom!
    const to = this.config.backfillTo || new Date()

    // Get all vaults for the period
    const vaults = await this.getVaultsInDateRange(from, to)

    for (const vault of vaults) {
      TransactionETLService.checkAbort(signal)
      await this.processVaultTransactions(vault, from, to)
    }
  }

  /**
   * Incremental sync using cursor-based pagination
   */
  async incrementalSync(signal?: AbortSignal): Promise<void> {
    console.log('Starting incremental sync...')

    let cursor = this.config.cursor || await this.getLastProcessedCursor()
    let hasMore = true
    let processedCount = 0

    while (hasMore && processedCount < this.config.batchSize) {
      TransactionETLService.checkAbort(signal)

      try {
        const operations = await this.fetchHorizonOperations(cursor)

        if (operations.length === 0) {
          hasMore = false
          break
        }

        const vaultTransactions = await this.filterAndTransformOperations(operations)

        if (vaultTransactions.length > 0) {
          await this.saveTransactions(vaultTransactions)
        }

        // Update cursor to the last operation's ID
        cursor = operations[operations.length - 1].id
        processedCount += operations.length

        console.log(`Processed ${processedCount} operations...`)

      } catch (error) {
        if (TransactionETLService.isAbortError(error)) {
          throw error
        }
        console.error(`Error processing batch at cursor ${cursor}:`, error)
        break
      }
    }
    
    // Save the last cursor for next run
    if (cursor) {
      await this.saveLastProcessedCursor(cursor)
    }
  }

  /**
   * Fetch operations from Stellar Horizon API
   */
  private async fetchHorizonOperations(cursor?: string): Promise<HorizonOperation[]> {
    try {
      let builder = this.server.operations()
        .order('asc')
        .limit(this.config.batchSize)
      
      if (cursor) {
        builder = builder.cursor(cursor)
      }
      
      const response = await builder.call()
      return response.records.map(this.transformHorizonOperation)
    } catch (error) {
      console.error('Error fetching Horizon operations:', error)
      throw error
    }
  }

  /**
   * Transform Horizon operation response to our interface
   */
  private transformHorizonOperation(record: any): HorizonOperation {
    return {
      id: record.id,
      type: record.type,
      transaction_hash: record.transaction_hash,
      created_at: record.created_at,
      transaction_successful: record.transaction_successful,
      source_account: record.source_account,
      amount: record.amount,
      asset_code: record.asset_code,
      asset_type: record.asset_type,
      from: record.from || record.source_account,
      to: record.to,
      name: record.name,
      value: record.value,
      ledger: record.ledger,
      fee_paid: record.fee_paid,
      memo: record.memo,
      memo_type: record.memo_type
    }
  }

  /**
   * Filter operations to only vault-related ones and transform to transactions
   */
  private async filterAndTransformOperations(operations: HorizonOperation[]): Promise<Transaction[]> {
    const transactions: Transaction[] = []
    
    for (const operation of operations) {
      if (!operation.transaction_successful) {
        continue // Skip failed transactions
      }
      
      const vaultReference = await this.findVaultForOperation(operation)
      if (!vaultReference) {
        continue // Skip operations not related to vaults
      }
      
      const transaction = await this.transformOperationToTransaction(operation, vaultReference)
      if (transaction) {
        transactions.push(transaction)
      }
    }
    
    return transactions
  }

  /**
   * Find which vault an operation belongs to
   */
  private async findVaultForOperation(operation: HorizonOperation): Promise<VaultReference | null> {
    try {
      // Strategy 1: Check memo for vault ID
      if (operation.memo && operation.memo_type === 'text') {
        const vault = await this.getVaultById(operation.memo)
        if (vault) return vault
      }
      
      // Strategy 2: Check manage_data operations for vault metadata
      if (operation.type === 'manage_data' && operation.name?.startsWith('vault_')) {
        const vaultId = operation.name.replace('vault_', '')
        const vault = await this.getVaultById(vaultId)
        if (vault) return vault
      }
      
      // Strategy 3: Check payment operations to/from vault-related accounts
      if (operation.type === 'payment') {
        const vault = await this.findVaultByAccounts(operation.from!, operation.to!)
        if (vault) return vault
      }

      // Strategy 4: Check Soroban events for vault ID
      const vaultFromEvents = await this.findVaultFromEvents(operation.transaction_hash)
      if (vaultFromEvents) return vaultFromEvents
      
      return null
    } catch (error) {
      console.error('Error finding vault for operation:', error)
      return null
    }
  }

  /**
   * Find vault ID from Soroban events in a transaction
   */
  private async findVaultFromEvents(txHash: string): Promise<VaultReference | null> {
    try {
      // Use type assertion to bypass potential SDK type missing methods for Horizon events
      const events = await (this.server as any).events()
        .forTransaction(txHash)
        .call()

      for (const event of events.records) {
        // Vault ID is usually in the first topic or in the value for vault-related events
        // For now, look for anything that looks like a vault ID in the topics
        for (const topic of event.topic) {
          if (topic.startsWith('vault_') || (topic.length === 36 && topic.includes('-'))) {
             const vaultId = topic.replace('vault_', '')
             const vault = await this.getVaultById(vaultId)
             if (vault) return vault
          }
        }
      }
      return null
    } catch (error) {
      // Silently ignore errors in event lookup to avoid failing the whole ETL run
      return null
    }
  }

  /**
   * Transform a Horizon operation to a Transaction record
   */
  private async transformOperationToTransaction(
    operation: HorizonOperation, 
    vault: VaultReference
  ): Promise<Transaction | null> {
    try {
      const type = this.mapOperationToTransactionType(operation)
      if (!type) return null
      
      return {
        id: crypto.randomUUID(),
        user_id: vault.user_id,
        vault_id: vault.id,
        tx_hash: operation.transaction_hash,
        type,
        amount: operation.amount || '0',
        asset_code: operation.asset_type === 'native' ? null : (operation.asset_code ?? null),
        from_account: operation.from || operation.source_account,
        to_account: operation.to || vault.success_destination,
        memo: operation.memo || null,
        created_at: new Date(),
        stellar_ledger: operation.ledger,
        stellar_timestamp: new Date(operation.created_at),
        explorer_url: `${this.STELLAR_EXPLORER_BASE}/${operation.transaction_hash}`
      }
    } catch (error) {
      console.error('Error transforming operation to transaction:', error)
      return null
    }
  }

  /**
   * Map Horizon operation types to our transaction types
   */
  private mapOperationToTransactionType(operation: HorizonOperation): Transaction['type'] | null {
    switch (operation.type) {
      case 'create_account':
        return 'creation'
      case 'payment':
        // Determine payment type based on direction and accounts
        if (operation.to?.includes('verifier')) return 'validation'
        if (operation.to?.includes('success')) return 'release'
        if (operation.to?.includes('failure')) return 'redirect'
        return 'release' // Default to release for payments
      case 'manage_data':
        if (operation.name?.includes('cancel')) return 'cancel'
        if (operation.name?.includes('redirect')) return 'redirect'
        return 'validation' // Default for manage_data
      default:
        return null
    }
  }

  /**
   * Save transactions to database with deduplication
   */
  private async saveTransactions(transactions: Transaction[]): Promise<void> {
    const trx = await db.transaction()
    
    try {
      for (const transaction of transactions) {
        // Check if transaction already exists
        const existing = await trx('transactions')
          .where('tx_hash', transaction.tx_hash)
          .first()
        
        if (!existing) {
          await trx('transactions').insert({
            id: transaction.id,
            user_id: transaction.user_id,
            vault_id: transaction.vault_id,
            tx_hash: transaction.tx_hash,
            type: transaction.type,
            amount: transaction.amount,
            asset_code: transaction.asset_code,
            from_account: transaction.from_account,
            to_account: transaction.to_account,
            memo: transaction.memo,
            created_at: transaction.created_at,
            stellar_ledger: transaction.stellar_ledger,
            stellar_timestamp: transaction.stellar_timestamp,
            explorer_url: transaction.explorer_url
          })
        }
      }
      
      await trx.commit()
      console.log(`Saved ${transactions.length} new transactions`)
    } catch (error) {
      await trx.rollback()
      console.error('Error saving transactions:', error)
      throw error
    }
  }

  // Helper methods for database queries
  private async getVaultsInDateRange(from: Date, to: Date): Promise<VaultReference[]> {
    return await db('vaults')
      .where('created_at', '>=', from)
      .where('created_at', '<=', to)
      .select('id', 'user_id', 'creator', 'verifier', 'success_destination', 'failure_destination')
  }

  private async getVaultById(vaultId: string): Promise<VaultReference | null> {
    return await db('vaults')
      .where('id', vaultId)
      .first()
  }

  private async findVaultByAccounts(fromAccount: string, toAccount: string): Promise<VaultReference | null> {
    return await db('vaults')
      .where(function() {
        this.where('creator', fromAccount)
          .orWhere('creator', toAccount)
          .orWhere('verifier', fromAccount)
          .orWhere('verifier', toAccount)
          .orWhere('success_destination', fromAccount)
          .orWhere('success_destination', toAccount)
          .orWhere('failure_destination', fromAccount)
          .orWhere('failure_destination', toAccount)
      })
      .first()
  }

  private async getLastProcessedCursor(): Promise<string | undefined> {
    // This could be stored in a separate etl_state table or Redis
    // For now, return undefined to start from the beginning
    return undefined
  }

  private async saveLastProcessedCursor(cursor: string): Promise<void> {
    // Save cursor for next incremental sync
    console.log(`Saving cursor: ${cursor}`)
    // TODO: Implement cursor persistence
  }

  // ---------------------------------------------------------------------------
  // Abort helpers
  // ---------------------------------------------------------------------------

  private static checkAbort(signal?: AbortSignal): void {
    if (signal?.aborted === true) {
      const err = new Error('ETL run aborted')
      err.name = 'AbortError'
      throw err
    }
  }

  static isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === 'AbortError'
  }

  private async processVaultTransactions(vault: VaultReference, from: Date, to: Date): Promise<void> {
    console.log(`Processing transactions for vault ${vault.id}`)
    
    // Get operations for vault's accounts in the date range
    const accounts = [
      vault.creator,
      vault.verifier,
      vault.success_destination,
      vault.failure_destination
    ].filter(Boolean)
    
    for (const account of accounts) {
      await this.processAccountTransactions(account, vault, from, to)
    }
  }

  private async processAccountTransactions(
    account: string, 
    vault: VaultReference, 
    from: Date, 
    to: Date
  ): Promise<void> {
    try {
      let operations = await this.server
        .operations()
        .forAccount(account)
        .order('asc')
        .limit(this.config.batchSize)
        .call()
      
      const vaultOperations = operations.records
        .filter(op => new Date(op.created_at) >= from && new Date(op.created_at) <= to)
        .map(this.transformHorizonOperation)
      
      const transactions = await this.filterAndTransformOperations(vaultOperations)
      
      if (transactions.length > 0) {
        await this.saveTransactions(transactions)
      }
      
    } catch (error) {
      console.error(`Error processing account ${account}:`, error)
    }
  }
}
