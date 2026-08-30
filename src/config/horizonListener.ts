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

export class HorizonListenerConfigError extends Error {
  constructor(
    message: string,
    public readonly errors: string[] = [],
  ) {
    super(message)
    this.name = 'HorizonListenerConfigError'
  }
}

const CONTRACT_ADDRESS_PATTERN = /^[A-Za-z0-9_-]{1,256}$/

/**
 * Validates a single contract address string format.
 */
export function isValidContractAddressString(address: unknown): address is string {
  return typeof address === 'string' && address.trim().length > 0 && CONTRACT_ADDRESS_PATTERN.test(address.trim())
}

/**
 * Sanitizes and deduplicates an array of contract addresses.
 */
export function sanitizeContractAddresses(addresses: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue
    const trimmed = raw.trim()
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed)
      result.push(trimmed)
    }
  }
  return result
}

/**
 * Load configuration from validated environment.
 * The validation is already performed by initEnv().
 */
export function loadHorizonListenerConfig(): HorizonListenerConfig {
  const env = getEnv()
  
  const contractAddressRaw = env.CONTRACT_ADDRESS
  
  const contractAddresses = contractAddressRaw
    ? sanitizeContractAddresses(contractAddressRaw.split(','))
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
 * Logs structured JSON errors and throws a typed error if validation fails.
 */
export function validateHorizonListenerConfig(config: HorizonListenerConfig): void {
  const errors: string[] = []

  // 1. Horizon URL validation
  if (!config.horizonUrl || typeof config.horizonUrl !== 'string' || config.horizonUrl.trim().length === 0) {
    errors.push('HORIZON_URL is required but not set')
  } else {
    try {
      const parsedUrl = new URL(config.horizonUrl.trim())
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        errors.push('HORIZON_URL must use http or https protocol')
      }
      if (!parsedUrl.hostname || parsedUrl.hostname.trim().length === 0) {
        errors.push('HORIZON_URL must contain a valid hostname')
      }
      if (parsedUrl.username || parsedUrl.password) {
        errors.push('HORIZON_URL must not contain embedded user credentials')
      }
    } catch {
      errors.push('HORIZON_URL must be a valid HTTP or HTTPS URL')
    }
  }

  // 2. Contract addresses validation
  if (!config.contractAddresses || !Array.isArray(config.contractAddresses) || config.contractAddresses.length === 0) {
    errors.push('CONTRACT_ADDRESS is required but not set or empty')
  } else {
    const invalidAddresses = config.contractAddresses.filter(
      (addr) => !isValidContractAddressString(addr),
    )
    if (invalidAddresses.length > 0) {
      errors.push(`CONTRACT_ADDRESS contains invalid contract address formats: ${invalidAddresses.join(', ')}`)
    }
  }

  // 3. Numeric bounds validation
  if (config.startLedger !== undefined) {
    if (
      typeof config.startLedger !== 'number' ||
      !Number.isSafeInteger(config.startLedger) ||
      config.startLedger < 0
    ) {
      errors.push('startLedger must be a non-negative safe integer')
    }
  }

  if (
    config.retryMaxAttempts !== undefined &&
    (typeof config.retryMaxAttempts !== 'number' ||
      !Number.isSafeInteger(config.retryMaxAttempts) ||
      config.retryMaxAttempts < 1 ||
      config.retryMaxAttempts > 100)
  ) {
    errors.push('retryMaxAttempts must be a safe integer between 1 and 100')
  }

  if (
    config.retryBackoffMs !== undefined &&
    (typeof config.retryBackoffMs !== 'number' ||
      !Number.isSafeInteger(config.retryBackoffMs) ||
      config.retryBackoffMs < 0 ||
      config.retryBackoffMs > 300_000)
  ) {
    errors.push('retryBackoffMs must be a safe integer between 0 and 300000ms')
  }

  if (
    config.shutdownTimeoutMs !== undefined &&
    (typeof config.shutdownTimeoutMs !== 'number' ||
      !Number.isSafeInteger(config.shutdownTimeoutMs) ||
      config.shutdownTimeoutMs < 1_000 ||
      config.shutdownTimeoutMs > 300_000)
  ) {
    errors.push('shutdownTimeoutMs must be a safe integer between 1000 and 300000ms')
  }

  if (
    config.lagThreshold !== undefined &&
    (typeof config.lagThreshold !== 'number' ||
      !Number.isSafeInteger(config.lagThreshold) ||
      config.lagThreshold < 0 ||
      config.lagThreshold > 100_000)
  ) {
    errors.push('lagThreshold must be a safe integer between 0 and 100000')
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
    throw new HorizonListenerConfigError('Horizon listener configuration validation failed', errors)
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

