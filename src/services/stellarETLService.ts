import { Server, Transaction as StellarTransaction, TransactionRecord } from 'stellar-sdk'
import { TransactionService } from './transactionService.js'
import { TransactionType } from '../types/transactions.js'

interface HorizonTransaction {
  id: string
  paging_token: string
  successful: boolean
  hash: string
  ledger: number
  created_at: string
  source_account: string
  source_account_sequence: string
  fee_paid: number
  fee_charged: number
  operation_count: number
  envelope_xdr: string
  result_xdr: string
  result_meta_xdr: string
  fee_meta_xdr: string
  memo?: string
  memo_type?: string
  signatures: any[]
  valid_after?: string
  valid_before?: string
  fee_bump_transaction?: any
  inner_transaction?: any
  operations: any[]
}

export class StellarETLService {
  private server: Server
  private isRunning: boolean = false
  private lastPagingToken: string | null = null

  constructor() {
    const horizonUrl = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org'
    this.server = new Server(horizonUrl)
  }

  async startETL(): Promise<void> {
    if (this.isRunning) {
      console.log('ETL service is already running')
      return
    }

    this.isRunning = true
    console.log('Starting Stellar Horizon ETL service...')

    // Start with initial sync
    await this.initialSync()

    // Start real-time streaming
    this.startStreaming()
  }

  async stopETL(): Promise<void> {
    this.isRunning = false
    console.log('Stopping Stellar Horizon ETL service...')
  }

  private async initialSync(): Promise<void> {
    console.log('Performing initial sync...')
    
    try {
      let transactions: HorizonTransaction[] = []
      let cursor = 'now' // Start from the most recent transactions and work backwards
      
      // Get transactions for the last 24 hours initially
      const startTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
      
      const builder = this.server
        .transactions()
        .forAccount(process.env.STELLAR_DISCIPLR_ACCOUNT || '') // Filter for Disciplr account
        .order('desc')
        .limit(200)

      if (startTime) {
        builder.fromTime(startTime)
      }

      const response = await builder.call()
      transactions = response.records

      console.log(`Found ${transactions.length} transactions for initial sync`)

      // Process transactions in batches
      await this.processTransactionsBatch(transactions)

      // Store the last paging token for streaming
      if (transactions.length > 0) {
        this.lastPagingToken = transactions[0].paging_token
      }

    } catch (error) {
      console.error('Initial sync failed:', error)
    }
  }

  private startStreaming(): void {
    console.log('Starting real-time transaction streaming...')

    const callBuilder = this.server
      .transactions()
      .forAccount(process.env.STELLAR_DISCIPLR_ACCOUNT || '')
      .cursor(this.lastPagingToken || 'now')

    callBuilder.stream({
      onmessage: (transaction: HorizonTransaction) => {
        this.processTransaction(transaction)
      },
      onerror: (error: any) => {
        console.error('Stream error:', error)
        // Implement retry logic with exponential backoff
        setTimeout(() => {
          if (this.isRunning) {
            this.startStreaming()
          }
        }, 5000)
      }
    })
  }

  private async processTransactionsBatch(transactions: HorizonTransaction[]): Promise<void> {
    const processedTransactions = []

    for (const tx of transactions) {
      try {
        const processedTx = await this.extractTransactionData(tx)
        if (processedTx) {
          processedTransactions.push(processedTx)
        }
      } catch (error) {
        console.error(`Failed to process transaction ${tx.hash}:`, error)
      }
    }

    if (processedTransactions.length > 0) {
      await TransactionService.createTransactionsBulk(processedTransactions)
      console.log(`Batch processed ${processedTransactions.length} transactions`)
    }
  }

  private async processTransaction(transaction: HorizonTransaction): Promise<void> {
    try {
      const processedTx = await this.extractTransactionData(transaction)
      if (processedTx) {
        await TransactionService.createTransaction(processedTx)
        console.log(`Processed transaction: ${transaction.hash}`)
      }
    } catch (error) {
      console.error(`Failed to process transaction ${transaction.hash}:`, error)
    }
  }

  private async extractTransactionData(transaction: HorizonTransaction): Promise<any> {
    // Skip unsuccessful transactions
    if (!transaction.successful) {
      return null
    }

    // Parse transaction operations to identify vault-related activities
    const vaultOperations = this.extractVaultOperations(transaction)
    
    if (vaultOperations.length === 0) {
      return null
    }

    // For now, we'll create a transaction record for each vault operation
    // In a real implementation, you might want to group operations differently
    const transactions = vaultOperations.map(op => ({
      userId: op.userId || transaction.source_account,
      vaultId: op.vaultId,
      type: op.type as TransactionType,
      amount: op.amount,
      timestamp: transaction.created_at,
      stellarHash: transaction.hash,
      link: this.generateStellarExplorerLink(transaction.hash),
      metadata: {
        ledger: transaction.ledger,
        operationIndex: op.operationIndex,
        operationType: op.operationType,
        ...op.metadata
      }
    }))

    // Return the first transaction for single processing, or all for batch
    return transactions.length === 1 ? transactions[0] : transactions
  }

  private extractVaultOperations(transaction: HorizonTransaction): any[] {
    const operations = []

    for (let i = 0; i < transaction.operations.length; i++) {
      const op = transaction.operations[i]
      
      // Look for vault-related operations
      // This is a simplified example - you'd need to implement actual vault operation detection
      if (this.isVaultOperation(op)) {
        operations.push({
          operationIndex: i,
          operationType: op.type,
          vaultId: this.extractVaultId(op),
          userId: this.extractUserId(op),
          type: this.mapOperationToTransactionType(op),
          amount: this.extractAmount(op),
          metadata: this.extractOperationMetadata(op)
        })
      }
    }

    return operations
  }

  private isVaultOperation(operation: any): boolean {
    // Implement logic to identify vault-related operations
    // This could be based on:
    // - Specific memo patterns
    // - Destination accounts that are vault contracts
    // - Operation types specific to vaults
    // - Custom data in operations
    
    // Example: Look for operations with vault-related memos
    if (operation.memo && typeof operation.memo === 'string') {
      return operation.memo.startsWith('vault-') || 
             operation.memo.includes('disciplr') ||
             operation.memo.includes('time-lock')
    }
    
    // Example: Look for specific operation types
    return operation.type === 'payment' || 
           operation.type === 'create_account' ||
           operation.type === 'set_options'
  }

  private extractVaultId(operation: any): string {
    // Extract vault ID from operation data
    // This could come from memo, destination account, or operation metadata
    if (operation.memo && typeof operation.memo === 'string') {
      const match = operation.memo.match(/vault-(.+)/)
      if (match) return match[1]
    }
    
    // Fallback to generating a vault ID from operation details
    return `vault-${operation.id || Date.now()}`
  }

  private extractUserId(operation: any): string {
    // Extract user ID from operation
    return operation.source_account || operation.from || operation.account
  }

  private mapOperationToTransactionType(operation: any): TransactionType {
    // Map Stellar operation types to Disciplr transaction types
    switch (operation.type) {
      case 'create_account':
        return 'creation'
      case 'payment':
        return this.determinePaymentType(operation)
      case 'set_options':
        return 'validation'
      default:
        return 'creation' // Default fallback
    }
  }

  private determinePaymentType(operation: any): TransactionType {
    // Determine payment type based on operation details
    if (operation.amount && operation.destination) {
      // Logic to determine if this is release, redirect, or cancel
      // This would depend on your vault contract design
      return 'release' // Default for payments
    }
    return 'creation'
  }

  private extractAmount(operation: any): string {
    // Extract amount from operation
    if (operation.amount) {
      return operation.amount
    }
    if (operation.starting_balance) {
      return operation.starting_balance
    }
    return '0' // Default fallback
  }

  private extractOperationMetadata(operation: any): Record<string, any> {
    // Extract additional metadata from operation
    return {
      operationType: operation.type,
      sourceAccount: operation.source_account,
      destination: operation.destination,
      asset: operation.asset,
      ...operation
    }
  }

  private generateStellarExplorerLink(hash: string): string {
    const network = process.env.STELLAR_NETWORK || 'testnet'
    const baseUrl = network === 'public' 
      ? 'https://stellar.expert/explorer/public/tx'
      : 'https://stellar.expert/explorer/testnet/tx'
    
    return `${baseUrl}/${hash}`
  }

  async getTransactionStatus(hash: string): Promise<any> {
    try {
      const transaction = await this.server.transactions().transaction(hash)
      return {
        hash: transaction.hash,
        successful: transaction.successful,
        ledger: transaction.ledger,
        created_at: transaction.created_at,
        operations: transaction.operations
      }
    } catch (error) {
      throw new Error(`Failed to get transaction status: ${error}`)
    }
  }
}
