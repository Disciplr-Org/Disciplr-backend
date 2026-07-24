import { randomUUID } from 'node:crypto'
import { TransactionETLService } from '../services/transactionETL.js'
import type { ETLBatchResult, ETLConfig } from '../types/transactions.js'

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000

export interface ETLWorkerOptions {
  drainTimeoutMs?: number
}

export class ETLWorker {
  private readonly etlService: TransactionETLService
  private readonly drainTimeoutMs: number

  private interval: NodeJS.Timeout | null = null
  private isRunning = false
  private activeRun: Promise<void> | null = null
  private abortController: AbortController | null = null

  /**
   * The batch ID for the *current* scheduled tick.
   *
   * A new UUID is generated once per tick (in `executeRun`) and reused on
   * every retry of that same tick so the ETL service can detect and skip
   * already-completed work.
   */
  private currentBatchId: string | null = null

  constructor(
    config: ETLConfig,
    options: ETLWorkerOptions = {},
    etlService?: TransactionETLService,
  ) {
    this.etlService = etlService ?? new TransactionETLService(config)
    this.drainTimeoutMs =
      typeof options.drainTimeoutMs === 'number' && options.drainTimeoutMs > 0
        ? options.drainTimeoutMs
        : DEFAULT_DRAIN_TIMEOUT_MS
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Start the ETL worker with periodic syncs.
   */
  start(intervalMinutes = 5): void {
    if (this.isRunning) {
      console.log('[ETLWorker] Already running')
      return
    }

    console.log(`[ETLWorker] Starting with ${intervalMinutes}-minute intervals`)
    this.isRunning = true

    this.executeRun()

    this.interval = setInterval(() => {
      this.executeRun()
    }, intervalMinutes * 60 * 1_000)
  }

  /**
   * Stop the ETL worker gracefully.
   *
   * 1. Prevents any new runs from starting.
   * 2. Signals the current in-flight run to abort via AbortSignal.
   * 3. Waits up to `drainTimeoutMs` for the run to finish before returning.
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return

    console.log('[ETLWorker] Stop requested – draining in-flight run...')
    this.isRunning = false

    if (this.interval !== null) {
      clearInterval(this.interval)
      this.interval = null
    }

    this.abortController?.abort()

    if (this.activeRun !== null) {
      const drain = this.activeRun.then(() => {}, () => {})
      const drainTimeout = new Promise<void>((resolve) => {
        setTimeout(() => {
          console.warn(
            `[ETLWorker] Drain timeout (${this.drainTimeoutMs}ms) exceeded – proceeding with shutdown`,
          )
          resolve()
        }, this.drainTimeoutMs)
      })
      await Promise.race([drain, drainTimeout])
    }

    console.log('[ETLWorker] Stopped')
  }

  /**
   * Manually trigger an ETL run.
   * No-op if the worker is not running or a run is already active.
   */
  async runETL(): Promise<void> {
    if (!this.isRunning || this.activeRun !== null) return

    this.executeRun()

    if (this.activeRun !== null) {
      await this.activeRun
    }
  }

  /**
   * Returns observable state for health checks and metrics.
   */
  getStatus(): { isRunning: boolean; hasInterval: boolean; hasActiveRun: boolean } {
    return {
      isRunning: this.isRunning,
      hasInterval: this.interval !== null,
      hasActiveRun: this.activeRun !== null,
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fire-and-forget run that tracks its own promise in `activeRun`.
   *
   * A fresh batch ID is generated for each new tick.  The same ID is reused
   * if `executeRun` is called again while `currentBatchId` is still set
   * (which shouldn't happen in normal operation, but is safe regardless).
   */
  private executeRun(): void {
    if (!this.isRunning || this.activeRun !== null) return

    // Generate a stable batch ID for this tick
    this.currentBatchId = randomUUID()
    const batchId = this.currentBatchId

    this.abortController = new AbortController()
    const { signal } = this.abortController

    this.activeRun = this.etlService
      .runETL()
      .then(() => {
        console.log(`[ETLWorker] Batch ${batchId} completed`)
      })
      .catch((error: unknown) => {
        if (signal.aborted) {
          console.log('[ETLWorker] In-flight run aborted during shutdown')
        } else {
          console.error('[ETLWorker] Unexpected run error:', error)
        }
      })
      .finally(() => {
        this.activeRun = null
        this.abortController = null
        this.currentBatchId = null
      })
  }
}

// ---------------------------------------------------------------------------
// Default singleton
// ---------------------------------------------------------------------------

const defaultConfig: ETLConfig = {
  horizonUrl: process.env.HORIZON_URL ?? 'https://horizon-testnet.stellar.org',
  networkPassphrase:
    process.env.STELLAR_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015',
  batchSize: 100,
  maxRetries: 3,
  backfillFrom: process.env.ETL_BACKFILL_FROM
    ? new Date(process.env.ETL_BACKFILL_FROM)
    : undefined,
  backfillTo: process.env.ETL_BACKFILL_TO
    ? new Date(process.env.ETL_BACKFILL_TO)
    : undefined,
}

export const etlWorker = new ETLWorker(defaultConfig)
