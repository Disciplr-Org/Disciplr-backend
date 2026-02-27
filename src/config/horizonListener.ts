/**
 * Configuration loader for Horizon Listener service
 * 
 * Loads and validates configuration from environment variables:
 * - HORIZON_URL: Stellar Horizon API endpoint (required)
 * - CONTRACT_ADDRESS: Comma-separated list of Soroban contract addresses to monitor (required)
 * - START_LEDGER: Initial ledger to start from if no cursor exists (optional)
 * - RETRY_MAX_ATTEMPTS: Maximum retry attempts for transient errors (optional, default: 3)
 * - RETRY_BACKOFF_MS: Initial backoff delay in milliseconds (optional, default: 100)
 */

export interface HorizonListenerConfig {
  horizonUrl: string
  contractAddresses: string[]
  startLedger?: number
  retryMaxAttempts: number
  retryBackoffMs: number
  shutdownTimeoutMs: number
}

/**
 * Load configuration from environment variables
 * Provides default values for optional settings
 */
export function loadHorizonListenerConfig(): HorizonListenerConfig {
  const horizonUrl = process.env.HORIZON_URL
  const contractAddressRaw = process.env.CONTRACT_ADDRESS
  const startLedgerRaw = process.env.START_LEDGER
  const retryMaxAttemptsRaw = process.env.RETRY_MAX_ATTEMPTS
  const retryBackoffMsRaw = process.env.RETRY_BACKOFF_MS

  // Parse CONTRACT_ADDRESS as comma-separated list
  const contractAddresses = contractAddressRaw
    ? contractAddressRaw.split(',').map(addr => addr.trim()).filter(addr => addr.length > 0)
    : []

  // Parse optional numeric values with defaults
  const startLedger = startLedgerRaw ? parseInt(startLedgerRaw, 10) : undefined
  const retryMaxAttempts = retryMaxAttemptsRaw ? parseInt(retryMaxAttemptsRaw, 10) : 3
  const retryBackoffMs = retryBackoffMsRaw ? parseInt(retryBackoffMsRaw, 10) : 100
  const shutdownTimeoutMs = 30000 // 30 seconds default

  return {
    horizonUrl: horizonUrl ?? '',
    contractAddresses,
    startLedger,
    retryMaxAttempts,
    retryBackoffMs,
    shutdownTimeoutMs,
  }
}

/**
 * Validate required configuration
 * Logs errors and exits with non-zero status if validation fails
 */
export function validateHorizonListenerConfig(config: HorizonListenerConfig): void {
  const errors: string[] = []

  // Check required fields
  if (!config.horizonUrl || config.horizonUrl.trim().length === 0) {
    errors.push('HORIZON_URL is required but not set')
  }

  if (!config.contractAddresses || config.contractAddresses.length === 0) {
    errors.push('CONTRACT_ADDRESS is required but not set or empty')
  }

  // Validate numeric values
  if (config.startLedger !== undefined && (isNaN(config.startLedger) || config.startLedger < 0)) {
    errors.push('START_LEDGER must be a non-negative number')
  }

  if (isNaN(config.retryMaxAttempts) || config.retryMaxAttempts < 0) {
    errors.push('RETRY_MAX_ATTEMPTS must be a non-negative number')
  }

  if (isNaN(config.retryBackoffMs) || config.retryBackoffMs < 0) {
    errors.push('RETRY_BACKOFF_MS must be a non-negative number')
  }

  // If validation fails, log errors and exit
  if (errors.length > 0) {
    console.error('Configuration validation failed:')
    errors.forEach(error => console.error(`  - ${error}`))
    process.exit(1)
  }
}

/**
 * Load and validate configuration
 * This is the main entry point for configuration management
 */
export function getValidatedConfig(): HorizonListenerConfig {
  const config = loadHorizonListenerConfig()
  validateHorizonListenerConfig(config)
  return config
}
