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

async function main(): Promise<void> {
  try {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.startup',
        service: 'disciplr-backend',
        message: 'Initialising Horizon Listener Service',
        timestamp: new Date().toISOString(),
      }),
    )

    const config = getValidatedConfig()

    console.log(
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
    await db.raw('SELECT 1')
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.db_connected',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )

    const checkpointStore = new CheckpointStore(db)

    const processorConfig: ProcessorConfig = {
      maxRetries: config.retryMaxAttempts,
      retryBackoffMs: config.retryBackoffMs,
    }
    const eventProcessor = new EventProcessor(db, processorConfig)
    const horizonListener = new HorizonListener(config, eventProcessor, db, checkpointStore)

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.listener_starting',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )

    await horizonListener.start()

    console.log(
      JSON.stringify({
        level: 'info',
        event: 'horizon.listener_running',
        service: 'disciplr-backend',
        timestamp: new Date().toISOString(),
      }),
    )
  } catch (error) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        event: 'horizon.startup_failed',
        service: 'disciplr-backend',
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        timestamp: new Date().toISOString(),
      }),
    )
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('Unhandled error in main:', error)
  process.exit(1)
})
