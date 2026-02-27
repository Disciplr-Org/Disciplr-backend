/**
 * Retry utility with exponential backoff for handling transient errors
 */

export interface RetryConfig {
  maxAttempts: number
  initialBackoffMs: number
  maxBackoffMs: number
  backoffMultiplier: number
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 3,
  initialBackoffMs: 100,
  maxBackoffMs: 60000,
  backoffMultiplier: 2,
}

/**
 * Sleep utility for backoff delays
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Predicate to determine if an error is retryable (transient)
 * Transient errors include database connection failures, deadlocks, and network timeouts
 */
export function isRetryable(error: Error): boolean {
  const errorMessage = error.message.toLowerCase()
  
  // Database connection errors
  if (errorMessage.includes('connection') || 
      errorMessage.includes('econnrefused') ||
      errorMessage.includes('enotfound') ||
      errorMessage.includes('etimedout')) {
    return true
  }
  
  // Database deadlock or lock timeout errors
  if (errorMessage.includes('deadlock') || 
      errorMessage.includes('lock timeout') ||
      errorMessage.includes('lock wait timeout')) {
    return true
  }
  
  // Network timeout errors
  if (errorMessage.includes('timeout') || 
      errorMessage.includes('timed out')) {
    return true
  }
  
  // Horizon API connection errors
  if (errorMessage.includes('horizon') && 
      (errorMessage.includes('connection') || errorMessage.includes('network'))) {
    return true
  }
  
  return false
}

/**
 * Retry an operation with exponential backoff
 * 
 * @param operation - The async operation to retry
 * @param config - Retry configuration
 * @param isRetryableFn - Optional custom predicate to determine if error is retryable
 * @returns The result of the operation
 * @throws The last error if all retry attempts are exhausted
 */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  isRetryableFn: (error: Error) => boolean = isRetryable
): Promise<T> {
  let lastError: Error
  let backoffMs = config.initialBackoffMs
  
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error
      
      // Don't retry if error is not retryable or we've exhausted attempts
      if (!isRetryableFn(lastError) || attempt === config.maxAttempts) {
        throw lastError
      }
      
      // Wait before retrying with exponential backoff
      await sleep(backoffMs)
      
      // Calculate next backoff with cap
      backoffMs = Math.min(
        backoffMs * config.backoffMultiplier,
        config.maxBackoffMs
      )
    }
  }
  
  // This should never be reached, but TypeScript needs it
  throw lastError!
}
