import { TransactionETLService } from '../services/transactionETL.js'
import type { ETLConfig } from '../types/transactions.js'

export class ETLWorker {
  private etlService: TransactionETLService
  private interval: NodeJS.Timeout | null = null
  private isRunning = false

  constructor(config: ETLConfig) {
    this.etlService = new TransactionETLService(config)
  }

  /**
   * Start the ETL worker with periodic syncs
   */
  start(intervalMinutes = 5): void {
    if (this.isRunning) {
      console.log('ETL worker is already running')
      return
    }

    console.log(`Starting ETL worker with ${intervalMinutes} minute intervals`)
    this.isRunning = true

    // Run immediately on start
    this.runETL().catch(error => {
      console.error('Initial ETL run failed:', error)
    })

    // Set up periodic runs
    this.interval = setInterval(() => {
      this.runETL().catch(error => {
        console.error('Scheduled ETL run failed:', error)
      })
    }, intervalMinutes * 60 * 1000)
  }

  /**
   * Stop the ETL worker
   */
  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    this.isRunning = false
    console.log('ETL worker stopped')
  }

  /**
   * Run ETL manually
   */
  async runETL(): Promise<void> {
    if (this.isRunning) {
      await this.etlService.runETL()
    }
  }

  /**
   * Get worker status
   */
  getStatus(): { isRunning: boolean; hasInterval: boolean } {
    return {
      isRunning: this.isRunning,
      hasInterval: this.interval !== null
    }
  }
}

// Default configuration
const defaultConfig: ETLConfig = {
  horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
  networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
  batchSize: 100,
  maxRetries: 3,
  backfillFrom: process.env.ETL_BACKFILL_FROM ? new Date(process.env.ETL_BACKFILL_FROM) : undefined,
  backfillTo: process.env.ETL_BACKFILL_TO ? new Date(process.env.ETL_BACKFILL_TO) : undefined
}

// Create singleton instance
export const etlWorker = new ETLWorker(defaultConfig)
