import { getEnv } from './index.js'

/**
 * Configuration loader for Horizon Listener service
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

/**
 * Load configuration from validated environment.
 * The validation is already performed by initEnv().
 */
export function loadHorizonListenerConfig(): HorizonListenerConfig {
  const env = getEnv()
  
  const contractAddressRaw = env.CONTRACT_ADDRESS
  
  const contractAddresses = contractAddressRaw
    ? contractAddressRaw.split(',').map((addr) => addr.trim()).filter((addr) => addr.length > 0)
    : []

  return {
    horizonUrl: env.HORIZON_URL ?? '',
    contractAddresses,
    startLedger: env.START_LEDGER,
    retryMaxAttempts: env.RETRY_MAX_ATTEMPTS,
    retryBackoffMs: env.RETRY_BACKOFF_MS,
    shutdownTimeoutMs: env.HORIZON_SHUTDOWN_TIMEOUT_MS,
    lagThreshold: env.HORIZON_LAG_THRESHOLD,
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
