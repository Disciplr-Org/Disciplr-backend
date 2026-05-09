/**
 * Configuration loader for Horizon Listener service
 *
 * Loads and validates configuration from environment variables:
 * - HORIZON_URL: Stellar Horizon API endpoint (required)
 * - CONTRACT_ADDRESS: Comma-separated list of Soroban contract addresses to monitor (required)
 * - START_LEDGER: Initial ledger to start from if no cursor exists (optional)
 * - RETRY_MAX_ATTEMPTS: Maximum retry attempts for transient errors (optional, default: 3)
 * - RETRY_BACKOFF_MS: Initial backoff delay in milliseconds (optional, default: 100)
 * - HORIZON_SHUTDOWN_TIMEOUT_MS: Graceful shutdown window in milliseconds (optional, default: 30000)
 * - HORIZON_LAG_THRESHOLD: Ledger lag count before alerting (optional, default: 10)
 */

export interface HorizonListenerConfig {
  horizonUrl: string
  contractAddresses: string[]
  startLedger?: number
  retryMaxAttempts: number
  retryBackoffMs: number
  shutdownTimeoutMs: number
  lagThreshold?: number
}

function parseNonNegativeInteger(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined) return fallback

  const normalizedValue = value.trim()
  if (normalizedValue.length === 0) return fallback
  if (!/^\d+$/.test(normalizedValue)) return Number.NaN

  return Number.parseInt(normalizedValue, 10)
}

/**
 * Load configuration from environment variables.
 * Provides default values for optional settings.
 */
export function loadHorizonListenerConfig(): HorizonListenerConfig {
  const horizonUrl = process.env.HORIZON_URL
  const contractAddressRaw = process.env.CONTRACT_ADDRESS
  const startLedgerRaw = process.env.START_LEDGER
  const retryMaxAttemptsRaw = process.env.RETRY_MAX_ATTEMPTS
  const retryBackoffMsRaw = process.env.RETRY_BACKOFF_MS
  const shutdownTimeoutMsRaw = process.env.HORIZON_SHUTDOWN_TIMEOUT_MS
  const lagThresholdRaw = process.env.HORIZON_LAG_THRESHOLD

  const contractAddresses = contractAddressRaw
    ? contractAddressRaw.split(',').map((addr) => addr.trim()).filter((addr) => addr.length > 0)
    : []

  const startLedger = parseNonNegativeInteger(startLedgerRaw)
  const retryMaxAttempts = parseNonNegativeInteger(retryMaxAttemptsRaw, 3) as number
  const retryBackoffMs = parseNonNegativeInteger(retryBackoffMsRaw, 100) as number
  const shutdownTimeoutMs = parseNonNegativeInteger(shutdownTimeoutMsRaw, 30_000) as number
  const lagThreshold = parseNonNegativeInteger(lagThresholdRaw, 10) as number

  return {
    horizonUrl: horizonUrl ?? '',
    contractAddresses,
    startLedger,
    retryMaxAttempts,
    retryBackoffMs,
    shutdownTimeoutMs,
    lagThreshold: lagThresholdRaw ? Number(lagThresholdRaw) : 30,
  }
}

/**
 * Validate required configuration fields and numeric bounds.
 * Logs structured JSON errors and exits with code 1 if validation fails.
 */
export function validateHorizonListenerConfig(config: HorizonListenerConfig): void {
  const errors: string[] = []

  if (!config.horizonUrl || config.horizonUrl.trim().length === 0) {
    errors.push('HORIZON_URL is required but not set')
  } else if (!/^https?:\/\/.+/.test(config.horizonUrl)) {
    errors.push('HORIZON_URL must be a valid HTTP or HTTPS URL')
  }

  if (!config.contractAddresses || config.contractAddresses.length === 0) {
    errors.push('CONTRACT_ADDRESS is required but not set or empty')
  }

  if (config.startLedger !== undefined && (isNaN(config.startLedger) || config.startLedger < 0)) {
    errors.push('START_LEDGER must be a non-negative integer')
  }

  if (isNaN(config.retryMaxAttempts) || config.retryMaxAttempts < 0) {
    errors.push('RETRY_MAX_ATTEMPTS must be a non-negative integer')
  }

  if (isNaN(config.retryBackoffMs) || config.retryBackoffMs < 0) {
    errors.push('RETRY_BACKOFF_MS must be a non-negative integer')
  }

  if (isNaN(config.shutdownTimeoutMs) || config.shutdownTimeoutMs <= 0) {
    errors.push('HORIZON_SHUTDOWN_TIMEOUT_MS must be a positive integer')
  }

  const lagThreshold = config.lagThreshold;
if (lagThreshold !== undefined && (isNaN(lagThreshold) || lagThreshold < 0)) {
    errors.push('HORIZON_LAG_THRESHOLD must be a non-negative integer')
  }

  if (errors.length > 0) {
    console.error(
      JSON.stringify({
        level: 'fatal',
        event: 'config.horizon_validation_failed',
        service: 'disciplr-backend',
        message: 'Horizon listener configuration validation failed — aborting startup',
        errors: errors.map((e) => `  - ${e}`),
        timestamp: new Date().toISOString(),
      }),
    )
    process.exit(1)
  }
}

/**
 * Load and validate configuration.
 * Main entry point for Horizon listener configuration management.
 */
export function getValidatedConfig(): HorizonListenerConfig {
  const config = loadHorizonListenerConfig()
  validateHorizonListenerConfig(config)
  return config
}
