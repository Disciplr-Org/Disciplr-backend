import { retryWithBackoff, isRetryable, sleep, DEFAULT_RETRY_CONFIG } from '../utils/retry.js'

describe('retry utility', () => {
  describe('sleep', () => {
    it('should delay for specified milliseconds', async () => {
      const start = Date.now()
      await sleep(100)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(90) // Allow some tolerance
      expect(elapsed).toBeLessThan(150)
    })
  })

  describe('isRetryable', () => {
    it('should return true for database connection errors', () => {
      expect(isRetryable(new Error('Connection refused'))).toBe(true)
      expect(isRetryable(new Error('ECONNREFUSED'))).toBe(true)
      expect(isRetryable(new Error('ENOTFOUND'))).toBe(true)
      expect(isRetryable(new Error('ETIMEDOUT'))).toBe(true)
    })

    it('should return true for database deadlock errors', () => {
      expect(isRetryable(new Error('Deadlock detected'))).toBe(true)
      expect(isRetryable(new Error('Lock timeout exceeded'))).toBe(true)
      expect(isRetryable(new Error('Lock wait timeout'))).toBe(true)
    })

    it('should return true for network timeout errors', () => {
      expect(isRetryable(new Error('Request timeout'))).toBe(true)
      expect(isRetryable(new Error('Operation timed out'))).toBe(true)
    })

    it('should return true for Horizon API connection errors', () => {
      expect(isRetryable(new Error('Horizon connection failed'))).toBe(true)
      expect(isRetryable(new Error('Horizon network error'))).toBe(true)
    })

    it('should return false for validation errors', () => {
      expect(isRetryable(new Error('Invalid payload'))).toBe(false)
      expect(isRetryable(new Error('Missing required field'))).toBe(false)
      expect(isRetryable(new Error('Schema validation failed'))).toBe(false)
    })

    it('should return false for business logic errors', () => {
      expect(isRetryable(new Error('Vault not found'))).toBe(false)
      expect(isRetryable(new Error('Unauthorized access'))).toBe(false)
    })
  })

  describe('retryWithBackoff', () => {
    it('should succeed on first attempt if operation succeeds', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        return 'success'
      }
      
      const result = await retryWithBackoff(operation)
      
      expect(result).toBe('success')
      expect(callCount).toBe(1)
    })

    it('should retry on transient errors and eventually succeed', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        if (callCount < 3) {
          throw new Error('Connection refused')
        }
        return 'success'
      }
      
      const result = await retryWithBackoff(operation)
      
      expect(result).toBe('success')
      expect(callCount).toBe(3)
    })

    it('should throw error immediately for non-retryable errors', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        throw new Error('Invalid payload')
      }
      
      await expect(retryWithBackoff(operation)).rejects.toThrow('Invalid payload')
      expect(callCount).toBe(1)
    })

    it('should throw error after max attempts for retryable errors', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        throw new Error('Connection refused')
      }
      
      await expect(retryWithBackoff(operation, { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3 }))
        .rejects.toThrow('Connection refused')
      expect(callCount).toBe(3)
    })

    it('should apply exponential backoff between retries', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        if (callCount < 3) {
          throw new Error('Connection refused')
        }
        return 'success'
      }
      
      const config = {
        maxAttempts: 3,
        initialBackoffMs: 50,
        maxBackoffMs: 1000,
        backoffMultiplier: 2,
      }
      
      const start = Date.now()
      await retryWithBackoff(operation, config)
      const elapsed = Date.now() - start
      
      // Should wait 50ms + 100ms = 150ms total (with some tolerance)
      expect(elapsed).toBeGreaterThanOrEqual(140)
      expect(elapsed).toBeLessThan(250)
    })

    it('should cap backoff at maxBackoffMs', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        if (callCount < 3) {
          throw new Error('Connection refused')
        }
        return 'success'
      }
      
      const config = {
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 120, // Cap at 120ms
        backoffMultiplier: 2,
      }
      
      const start = Date.now()
      await retryWithBackoff(operation, config)
      const elapsed = Date.now() - start
      
      // Should wait 100ms + 120ms (capped) = 220ms total
      expect(elapsed).toBeGreaterThanOrEqual(210)
      expect(elapsed).toBeLessThan(300)
    })

    it('should use custom isRetryable predicate when provided', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        throw new Error('Custom error')
      }
      const customIsRetryable = (error: Error) => error.message.includes('Custom')
      
      await expect(retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, customIsRetryable))
        .rejects.toThrow('Custom error')
      
      // Should retry because custom predicate returns true
      expect(callCount).toBe(3)
    })

    it('should not retry when custom predicate returns false', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        throw new Error('Custom error')
      }
      const customIsRetryable = () => false
      
      await expect(retryWithBackoff(operation, DEFAULT_RETRY_CONFIG, customIsRetryable))
        .rejects.toThrow('Custom error')
      
      // Should not retry
      expect(callCount).toBe(1)
    })
  })
})
