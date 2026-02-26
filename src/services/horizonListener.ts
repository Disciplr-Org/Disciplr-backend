import { Knex } from 'knex'
import { EventProcessor } from './eventProcessor.js'
import { parseHorizonEvent, HorizonEvent } from './eventParser.js'
import { HorizonListenerConfig } from '../config/horizonListener.js'
import { sleep } from '../utils/retry.js'

/**
 * Horizon Listener Service
 * Connects to Stellar Horizon API to receive Soroban contract events
 * and processes them into database operations
 */
export class HorizonListener {
  private config: HorizonListenerConfig
  private eventProcessor: EventProcessor
  private db: Knex
  private running: boolean = false
  private shutdownRequested: boolean = false
  private inFlightEvents: number = 0
  private reconnectAttempts: number = 0
  private currentBackoffMs: number = 1000

  // Stellar SDK Server instance (will be initialized when SDK is available)
  private server: any = null

  constructor(
    config: HorizonListenerConfig,
    eventProcessor: EventProcessor,
    db: Knex
  ) {
    this.config = config
    this.eventProcessor = eventProcessor
    this.db = db
  }

  /**
   * Start the Horizon listener
   * Loads cursor from database and begins event streaming
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn('Horizon listener is already running')
      return
    }

    console.log('Starting Horizon listener...')
    this.running = true
    this.shutdownRequested = false

    // Register signal handlers for graceful shutdown
    this.registerShutdownHandlers()

    // Load cursor from database
    const cursor = await this.loadCursor()
    console.log(`Resuming from ledger: ${cursor}`)

    // Start event streaming with retry logic
    await this.startEventStream(cursor)
  }

  /**
   * Stop the Horizon listener gracefully
   * Waits for in-flight events to complete before closing connections
   */
  async stop(): Promise<void> {
    if (!this.running) {
      console.warn('Horizon listener is not running')
      return
    }

    console.log('Stopping Horizon listener...')
    this.shutdownRequested = true

    // Wait for in-flight events with timeout
    const shutdownStart = Date.now()
    while (this.inFlightEvents > 0) {
      const elapsed = Date.now() - shutdownStart
      if (elapsed > this.config.shutdownTimeoutMs) {
        console.warn(
          `Shutdown timeout exceeded (${this.config.shutdownTimeoutMs}ms). ` +
          `${this.inFlightEvents} events still in flight. Force terminating.`
        )
        break
      }
      await sleep(100)
    }

    // Close Horizon connection
    if (this.server) {
      // TODO: Close Stellar SDK connection when SDK is available
      this.server = null
    }

    // Close database connection
    // Note: We don't destroy the db connection here as it may be shared
    // The caller should handle database cleanup

    this.running = false
    console.log('Horizon listener stopped')
  }

  /**
   * Check if the listener is currently running
   */
  isRunning(): boolean {
    return this.running
  }

  /**
   * Load the last processed ledger cursor from database
   * Returns START_LEDGER from config if no cursor exists
   */
  private async loadCursor(): Promise<number> {
    try {
      const state = await this.db('listener_state')
        .where({ service_name: 'horizon_listener' })
        .first()

      if (state && state.last_processed_ledger) {
        return state.last_processed_ledger
      }

      // No cursor exists, use START_LEDGER from config or default to 1
      return this.config.startLedger ?? 1
    } catch (error) {
      console.error('Error loading cursor from database:', error)
      // Fall back to config or default
      return this.config.startLedger ?? 1
    }
  }

  /**
   * Update the cursor in the database after successful event processing
   */
  private async updateCursor(ledgerNumber: number): Promise<void> {
    try {
      await this.db('listener_state')
        .insert({
          service_name: 'horizon_listener',
          last_processed_ledger: ledgerNumber,
          last_processed_at: new Date(),
          created_at: new Date(),
          updated_at: new Date()
        })
        .onConflict('service_name')
        .merge({
          last_processed_ledger: ledgerNumber,
          last_processed_at: new Date(),
          updated_at: new Date()
        })
    } catch (error) {
      // Log error but don't throw - cursor update failure shouldn't stop processing
      console.error('Error updating cursor:', error)
    }
  }

  /**
   * Start event streaming from Horizon API with retry logic
   */
  private async startEventStream(startLedger: number): Promise<void> {
    while (this.running && !this.shutdownRequested) {
      try {
        // TODO: Initialize Stellar SDK Server when available
        // For now, this is a placeholder that will be replaced with actual SDK integration
        // Example:
        // import { Server } from '@stellar/stellar-sdk'
        // this.server = new Server(this.config.horizonUrl)
        
        console.log('Horizon SDK not yet integrated - placeholder implementation')
        console.log(`Would connect to: ${this.config.horizonUrl}`)
        console.log(`Monitoring contracts: ${this.config.contractAddresses.join(', ')}`)
        console.log(`Starting from ledger: ${startLedger}`)

        // TODO: Replace with actual Horizon event streaming
        // Example:
        // const eventStream = this.server
        //   .events()
        //   .cursor(startLedger.toString())
        //   .stream({
        //     onmessage: (event) => this.handleEvent(event),
        //     onerror: (error) => this.handleStreamError(error)
        //   })

        // Reset reconnect attempts on successful connection
        this.reconnectAttempts = 0
        this.currentBackoffMs = 1000

        // For now, just wait to simulate running
        await sleep(1000)
        
        // In production, the stream would keep running until an error occurs
        // For this placeholder, we'll break after one iteration
        break
      } catch (error) {
        await this.handleConnectionError(error as Error)
      }
    }
  }

  /**
   * Handle individual event from Horizon stream
   */
  private async handleEvent(rawEvent: HorizonEvent): Promise<void> {
    // Don't accept new events if shutdown requested
    if (this.shutdownRequested) {
      return
    }

    this.inFlightEvents++

    try {
      // Filter by contract address
      if (!this.isEventFromConfiguredContract(rawEvent)) {
        return
      }

      // Parse event
      const parseResult = parseHorizonEvent(rawEvent)
      if (!parseResult.success) {
        console.error('Failed to parse event:', parseResult.error, parseResult.details)
        return
      }

      // Process event
      const result = await this.eventProcessor.processEvent(parseResult.event)
      
      if (result.success) {
        // Update cursor after successful processing
        await this.updateCursor(rawEvent.ledger)
      } else {
        console.error('Failed to process event:', result.error)
      }
    } catch (error) {
      console.error('Error handling event:', error)
    } finally {
      this.inFlightEvents--
    }
  }

  /**
   * Check if event is from a configured contract address
   */
  private isEventFromConfiguredContract(event: HorizonEvent): boolean {
    return this.config.contractAddresses.includes(event.contractId)
  }

  /**
   * Handle connection errors with exponential backoff
   */
  private async handleConnectionError(error: Error): Promise<void> {
    this.reconnectAttempts++

    // Log at WARN level every 10 failed attempts
    if (this.reconnectAttempts % 10 === 0) {
      console.warn(
        `Horizon connection failed ${this.reconnectAttempts} times. ` +
        `Last error: ${error.message}`
      )
    }

    // Wait with exponential backoff before retrying
    await sleep(this.currentBackoffMs)

    // Increase backoff with cap at 60 seconds
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, 60000)
  }

  /**
   * Handle stream errors
   */
  private handleStreamError(error: Error): void {
    console.error('Horizon stream error:', error)
    // The stream will automatically reconnect via the retry logic in startEventStream
  }

  /**
   * Register SIGTERM and SIGINT handlers for graceful shutdown
   */
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
