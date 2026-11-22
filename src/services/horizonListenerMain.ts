/**
 * Horizon Listener Service Entry Point
 *
 * Loads configuration, initialises the database, wires together the
 * CheckpointStore, EventProcessor, and HorizonListener, then starts listening.
 *
 * Usage:
 *   node dist/services/horizonListenerMain.js
 *
 * Environment Variables:
 *   HORIZON_URL         - Stellar Horizon API endpoint (required)
 *   CONTRACT_ADDRESS    - Comma-separated contract addresses (required)
 *   START_LEDGER        - Ledger to start from when no checkpoint exists (optional)
 *   RETRY_MAX_ATTEMPTS  - Max retry attempts (optional, default: 3)
 *   RETRY_BACKOFF_MS    - Initial backoff delay in ms (optional, default: 100)
 */

import { db } from '../db/knex.js'
import { EventProcessor } from './eventProcessor.js'
import { HorizonListener } from './horizonListener.js'
import { CheckpointStore } from './checkpointStore.js'
import { getValidatedConfig } from '../config/horizonListener.js'
import { ProcessorConfig } from '../types/horizonSync.js'

export interface HorizonListenerMainDeps {
  db?: typeof db
  getValidatedConfig?: typeof getValidatedConfig
  CheckpointStoreClass?: typeof CheckpointStore
  EventProcessorClass?: typeof EventProcessor
  HorizonListenerClass?: typeof HorizonListener
  exit?: (code?: number) => void
  logger?: {
    log: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export async function main(deps: HorizonListenerMainDeps = {}): Promise<void> {
  const {
    db: database = db,
    getValidatedConfig: getConfig = getValidatedConfig,
    CheckpointStoreClass = CheckpointStore,
    EventProcessorClass = EventProcessor,
    HorizonListenerClass = HorizonListener,
    exit = process.exit.bind(process),
    logger = console,
  } = deps

  try {
    logger.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.startup',
        service: 'disciplr-backend',
        message: 'Initialising Horizon Listener Service',
        timestamp: new Date().toISOString(),
      }),
    )

    const config = getConfig()

    logger.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.config_loaded',
        service: 'disciplr-backend',
        horizonUrl: config.horizonUrl,
        contractCount: config.contractAddresses.length,
        contracts: config.contractAddresses,
        startLedger: config.startLedger ?? 'from_checkpoint',
        retryMaxAttempts: config.retryMaxAttempts,
        retryBackoffMs: config.retryBackoffMs,
        timestamp: new Date().toISOString(),
      }),
    )

    // Verify database connectivity.
    await database.raw('SELECT 1')
    logger.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.db_connected',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )

    const checkpointStore = new CheckpointStoreClass(database)

    const processorConfig: ProcessorConfig = {
      maxRetries: config.retryMaxAttempts,
      retryBackoffMs: config.retryBackoffMs,
    }
    const eventProcessor = new EventProcessorClass(database, processorConfig)
    const horizonListener = new HorizonListenerClass(config, eventProcessor, database, checkpointStore)

    logger.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.listener_starting',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )

    await horizonListener.start()

    logger.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.listener_running',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )
  } catch (error) {
    logger.error(
      JSON.stringify({
        level: 'fatal',
        event: 'horizon.startup_failed',
        service: 'disciplr-backend',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    )
    exit(1)
  }
}

export default main

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  (process.argv[1].endsWith('horizonListenerMain.ts') ||
    process.argv[1].endsWith('horizonListenerMain.js'))

if (isMain) {
  main().catch((error) => {
    console.error('Unhandled error in main:', error)
    process.exit(1)
  })
}
