/**
 * Horizon Listener Service Entry Point
 * 
 * This is the main entry point for the Horizon listener service.
 * It loads configuration, initializes the database, creates the EventProcessor
 * and HorizonListener instances, and starts the listener.
 * 
 * Usage:
 *   node dist/services/horizonListenerMain.js
 * 
 * Environment Variables:
 *   HORIZON_URL - Stellar Horizon API endpoint (required)
 *   CONTRACT_ADDRESS - Comma-separated list of contract addresses (required)
 *   START_LEDGER - Initial ledger to start from (optional)
 *   RETRY_MAX_ATTEMPTS - Maximum retry attempts (optional, default: 3)
 *   RETRY_BACKOFF_MS - Initial backoff delay in ms (optional, default: 100)
 */

import { db } from '../db/knex.js'
import { EventProcessor } from './eventProcessor.js'
import { HorizonListener } from './horizonListener.js'
import { getValidatedConfig } from '../config/horizonListener.js'
import { ProcessorConfig } from '../types/horizonSync.js'

/**
 * Main function to start the Horizon listener service
 */
async function main(): Promise<void> {
  try {
    console.log('Initializing Horizon Listener Service...')

    // Load and validate configuration
    const config = getValidatedConfig()
    console.log('Configuration loaded successfully')
    console.log(`  Horizon URL: ${config.horizonUrl}`)
    console.log(`  Contract Addresses: ${config.contractAddresses.join(', ')}`)
    console.log(`  Start Ledger: ${config.startLedger ?? 'from cursor'}`)
    console.log(`  Max Retry Attempts: ${config.retryMaxAttempts}`)
    console.log(`  Retry Backoff: ${config.retryBackoffMs}ms`)

    // Initialize database connection
    console.log('Connecting to database...')
    // Test database connection
    await db.raw('SELECT 1')
    console.log('Database connection established')

    // Create EventProcessor instance
    const processorConfig: ProcessorConfig = {
      maxRetries: config.retryMaxAttempts,
      retryBackoffMs: config.retryBackoffMs
    }
    const eventProcessor = new EventProcessor(db, processorConfig)
    console.log('EventProcessor initialized')

    // Create HorizonListener instance
    const horizonListener = new HorizonListener(config, eventProcessor, db)
    console.log('HorizonListener initialized')

    // Start the listener
    console.log('Starting Horizon listener...')
    await horizonListener.start()

    console.log('Horizon Listener Service is running')
  } catch (error) {
    // Handle startup errors gracefully
    console.error('Failed to start Horizon Listener Service:')
    
    if (error instanceof Error) {
      console.error(`  Error: ${error.message}`)
      if (error.stack) {
        console.error(`  Stack: ${error.stack}`)
      }
    } else {
      console.error(`  Error: ${String(error)}`)
    }

    // Exit with non-zero status code
    process.exit(1)
  }
}

// Run the main function
main().catch((error) => {
  console.error('Unhandled error in main:', error)
  process.exit(1)
})
