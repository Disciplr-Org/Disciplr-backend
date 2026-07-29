import { Horizon } from '@stellar/stellar-sdk'
import { Knex } from 'knex'
import { EventProcessor } from './eventProcessor.js'
import { parseHorizonEvent, HorizonEvent } from './eventParser.js'
import { HorizonListenerConfig } from '../config/horizonListener.js'
import { CheckpointStore } from './checkpointStore.js'
import { sleep } from '../utils/retry.js'

/**
 * HorizonListener
 *
 * Connects to the Stellar Horizon API, streams Soroban contract events, and
 * drives them through EventProcessor.  After each successful commit the
 * CheckpointStore is updated so the service can resume from the correct ledger
 * after a restart without reprocessing already-committed events.
 *
 * Restart / resume guarantee
 * ──────────────────────────
 * At startup the listener loads the stored checkpoint for every configured
 * contract address.  The effective stream cursor is the MINIMUM confirmed
 * ledger across all contracts, ensuring that a contract with no checkpoint (or
 * a lower checkpoint) receives all missed events.  Events for contracts that
 * are already ahead of the stream cursor are re-delivered but are silently
 * skipped by the processed_events idempotency table — giving at-least-once
 * delivery with no duplicate side-effects.
 */
export class HorizonListener {
  private config: HorizonListenerConfig
  private eventProcessor: EventProcessor
  private db: Knex
  private checkpointStore: CheckpointStore
  private running: boolean = false
  private shutdownRequested: boolean = false
  private inFlightEvents: number = 0
  private reconnectAttempts: number = 0
  private currentBackoffMs: number = 1000

  // Close function returned by Horizon SSE stream; null when not streaming.
  private streamClose: (() => void) | null = null

  // Resolves when the active stream should be torn down (shutdown or reconnect).
  private streamDone: (() => void) | null = null

  // Resolves when stop() is called so backoff sleeps can be interrupted.
  private shutdownResolve: (() => void) | null = null
  private shutdownPromise: Promise<void> = Promise.resolve()

  constructor(
    config: HorizonListenerConfig,
    eventProcessor: EventProcessor,
    db: Knex,
    checkpointStore?: CheckpointStore,
  ) {
    this.config = config
    this.eventProcessor = eventProcessor
    this.db = db
    this.checkpointStore = checkpointStore ?? new CheckpointStore(db)
  }

  /**
   * Start the listener.
   * Loads per-contract cursors from the database and begins event streaming
   * from the minimum ledger across all contracts.
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('Horizon listener is already running')
      return
    }

    console.log('Starting Horizon listener...')
    this.running = true
    this.shutdownRequested = false

    this.registerShutdownHandlers()

    const startLedger = await this.loadEffectiveStartLedger()
    console.log(`Starting event stream from ledger: ${startLedger}`)

    await this.startEventStream(startLedger)
  }

  /**
   * Stop the listener gracefully.
   * Waits for in-flight events to drain before closing the connection.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      console.warn('Horizon listener is not running')
      return
    }

    console.log('Stopping Horizon listener...')
    this.shutdownRequested = true

    if (this.shutdownResolve) {
      this.shutdownResolve()
      this.shutdownResolve = null
    }

    const shutdownStart = Date.now()
    while (this.inFlightEvents > 0) {
      const elapsed = Date.now() - shutdownStart
      if (elapsed > this.config.shutdownTimeoutMs) {
        console.warn(
          `Shutdown timeout exceeded (${this.config.shutdownTimeoutMs}ms). ` +
          `${this.inFlightEvents} events still in flight. Force terminating.`,
        )
        break
      }
      await sleep(100)
    }

    if (this.streamClose) {
      this.streamClose()
      this.streamClose = null
    }

    if (this.streamDone) {
      this.streamDone()
      this.streamDone = null
    }

    this.running = false
    console.log('Horizon listener stopped')
  }

  /** True while the listener is actively streaming. */
  isRunning(): boolean {
    return this.running
  }

  // ── Private: cursor management ──────────────────────────────────────────────

  /**
   * Load each contract's checkpoint and return the minimum confirmed ledger
   * across all contracts.  Missing checkpoints fall back to config.startLedger.
   */
  async loadEffectiveStartLedger(): Promise<number> {
    const defaultLedger = this.config.startLedger ?? 1
    let minLedger = Infinity

    for (const contractAddress of this.config.contractAddresses) {
      try {
        const checkpoint = await this.checkpointStore.getCheckpoint(contractAddress)
        const ledger = checkpoint?.lastLedger ?? defaultLedger

        console.log(
          JSON.stringify({
            level: 'info',
            event: 'horizon.checkpoint_loaded',
            service: 'disciplr-backend',
            contractAddress,
            lastLedger: ledger,
            hasCheckpoint: checkpoint !== null,
            timestamp: new Date().toISOString(),
          }),
        )

        if (ledger < minLedger) minLedger = ledger
      } catch (error) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'horizon.checkpoint_load_error',
            service: 'disciplr-backend',
            contractAddress,
            error: error instanceof Error ? error.message : String(error),
            timestamp: new Date().toISOString(),
          }),
        )
        // Fail-safe: use default ledger so the contract is not silently skipped.
        if (defaultLedger < minLedger) minLedger = defaultLedger
      }
    }

    return minLedger === Infinity ? defaultLedger : minLedger
  }

  /**
   * Persist the confirmed checkpoint for a single contract.
   * Errors are logged but not re-thrown — a checkpoint write failure means
   * the event may be re-delivered on next restart, which idempotency absorbs.
   */
  private async persistCheckpoint(
    contractId: string,
    ledger: number,
    pagingToken: string,
  ): Promise<void> {
    try {
      await this.checkpointStore.upsertCheckpoint(contractId, ledger, pagingToken)
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'horizon.checkpoint_write_error',
          service: 'disciplr-backend',
          contractAddress: contractId,
          ledger,
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      )
    }
  }

  // ── Private: streaming ───────────────────────────────────────────────────────

  private async startEventStream(startLedger: number): Promise<void> {
    let cursor = startLedger

    this.shutdownPromise = new Promise<void>((resolve) => {
      this.shutdownResolve = resolve
    })

    while (this.running && !this.shutdownRequested) {
      try {
        const server = new Horizon.Server(this.config.horizonUrl)

        console.log(
          JSON.stringify({
            level: 'info',
            event: 'horizon.stream_connected',
            service: 'disciplr-backend',
            horizonUrl: this.config.horizonUrl,
            contracts: this.config.contractAddresses,
            cursor,
            timestamp: new Date().toISOString(),
          }),
        )

        // Create a promise that resolves when the stream ends or shutdown is requested.
        await new Promise<void>((resolve) => {
          this.streamDone = resolve

          const closeStream = (server as any).events()
            .cursor(cursor.toString())
            .stream({
              onmessage: (event: HorizonEvent) => {
                // Advance cursor so a reconnect resumes after this event.
                if (typeof event.ledger === 'number') {
                  cursor = event.ledger
                }
                void this.handleEvent(event)
              },
              onerror: (error: Error) => {
                this.handleStreamError(error)
                // Tear down this stream connection so the reconnect loop fires.
                resolve()
              },
            }) as () => void

          this.streamClose = () => {
            closeStream()
            resolve()
          }
        })

        // Reset backoff on a clean connection.
        if (!this.shutdownRequested) {
          this.reconnectAttempts = 0
          this.currentBackoffMs = 1000
        }

        this.streamClose = null
        this.streamDone = null

        if (this.shutdownRequested) break

        console.log(
          JSON.stringify({
            level: 'info',
            event: 'horizon.stream_disconnected',
            service: 'disciplr-backend',
            horizonUrl: this.config.horizonUrl,
            cursor,
            timestamp: new Date().toISOString(),
          }),
        )

        // Reconnect immediately after a non-error disconnect.
        cursor = await this.loadEffectiveStartLedger()
      } catch (error) {
        this.streamClose = null
        this.streamDone = null
        await this.handleConnectionError(error as Error)
        // Reload cursor from checkpoint before retrying.
        cursor = await this.loadEffectiveStartLedger()
      }
    }
  }

  /**
   * Process one event from the Horizon stream.
   *
   * The event is filtered by contract address, parsed, processed (with
   * idempotency), and — on success — the per-contract checkpoint is advanced.
   */
  async handleEvent(rawEvent: HorizonEvent): Promise<void> {
    if (this.shutdownRequested) return

    this.inFlightEvents++

    try {
      if (!this.isEventFromConfiguredContract(rawEvent)) {
        return
      }

      const parseResult = parseHorizonEvent(rawEvent)
      if (!parseResult.success) {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'horizon.event_parse_failed',
            service: 'disciplr-backend',
            error: parseResult.error,
            details: parseResult.details,
            timestamp: new Date().toISOString(),
          }),
        )
        return
      }

      const result = await this.eventProcessor.processEvent(parseResult.event)

      if (result.success) {
        // Advance the checkpoint for the specific contract this event came from.
        await this.persistCheckpoint(
          rawEvent.contractId,
          rawEvent.ledger,
          rawEvent.pagingToken,
        )
      } else {
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'horizon.event_processing_failed',
            service: 'disciplr-backend',
            eventId: parseResult.event.eventId,
            error: result.error,
            timestamp: new Date().toISOString(),
          }),
        )
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'horizon.event_handler_error',
          service: 'disciplr-backend',
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
        }),
      )
    } finally {
      this.inFlightEvents--
    }
  }

  private isEventFromConfiguredContract(event: HorizonEvent): boolean {
    return this.config.contractAddresses.includes(event.contractId)
  }

  private async handleConnectionError(error: Error): Promise<void> {
    this.reconnectAttempts++

    if (this.reconnectAttempts % 10 === 0) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'horizon.connection_error',
          service: 'disciplr-backend',
          attempts: this.reconnectAttempts,
          error: error.message,
          timestamp: new Date().toISOString(),
        }),
      )
    }

    // Race the backoff sleep against the shutdown signal so stop() wakes us.
    await Promise.race([sleep(this.currentBackoffMs), this.shutdownPromise])
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, 60_000)
  }

  private handleStreamError(error: Error): void {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'horizon.stream_error',
        service: 'disciplr-backend',
        error: error.message,
        timestamp: new Date().toISOString(),
      }),
    )
  }

  private registerShutdownHandlers(): void {
    const shutdownHandler = async () => {
      console.log('Shutdown signal received')
      await this.stop()
      process.exit(0)
    }

    process.on('SIGTERM', shutdownHandler)
    process.on('SIGINT', shutdownHandler)
  }
}
