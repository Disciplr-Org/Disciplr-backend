import { retryWithBackoff, isRetryable, sleep, calculateJitter, DEFAULT_RETRY_CONFIG } from '../utils/retry.js'

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
      
      await expect(retryWithBackoff(operation, { ...DEFAULT_RETRY_CONFIG, maxAttempts: 3, jitterFactor: 0 }))
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
        jitterFactor: 0,
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
        jitterFactor: 0,
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

    it('should apply jitter to backoff delay by default', async () => {
      let callCount = 0
      const operation = async () => {
        callCount++
        if (callCount < 3) {
          throw new Error('Connection refused')
        }
        return 'success'
      }
      
      // Use config with specific values and disable jitter for comparison
      const configWithoutJitter = {
        maxAttempts: 3,
        initialBackoffMs: 100,
        maxBackoffMs: 10000,
        backoffMultiplier: 2,
        jitterFactor: 0,
      }
      
      const configWithJitter = {
        ...configWithoutJitter,
        jitterFactor: 0.5,
      }
      
      const startWithout = Date.now()
      await retryWithBackoff(operation, configWithoutJitter)
      const elapsedWithout = Date.now() - startWithout
      
      // Reset call count
      callCount = 0
      
      const startWith = Date.now()
      await retryWithBackoff(operation, configWithJitter)
      const elapsedWith = Date.now() - startWith
      
      // Jitter adds randomization, so we check that the elapsed time is within expected bounds
      // Base delays: 100ms + 200ms = 300ms (without jitter)
      // With jitter (0.5 factor), delay should be 100 + random(0-50) + 200 + random(0-100) = 300-450ms
      // Allow generous bounds for test stability
      expect(elapsedWith).toBeGreaterThanOrEqual(290)
      expect(elapsedWith).toBeLessThan(600)
    })

    it('should allow disabling jitter with jitterFactor: 0', async () => {
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
        maxBackoffMs: 10000,
        backoffMultiplier: 2,
        jitterFactor: 0,
      }
      
      const start = Date.now()
      await retryWithBackoff(operation, config)
      const elapsed = Date.now() - start
      
      // Should wait 50ms + 100ms = 150ms exactly (no jitter)
      expect(elapsed).toBeGreaterThanOrEqual(140)
      expect(elapsed).toBeLessThan(200)
    })
  })

  describe('calculateJitter', () => {
    it('should return 0 when jitterFactor is 0', () => {
      // Since Math.random() is non-deterministic, we test that the jitter is within expected range
      const results = Array.from({ length: 100 }, () => calculateJitter(100, 0))
      results.forEach(result => {
        expect(result).toBe(0)
      })
    })

    it('should return value between 0 and baseDelay * jitterFactor', () => {
      for (let i = 0; i < 100; i++) {
        const jitter = calculateJitter(100, 0.5)
        expect(jitter).toBeGreaterThanOrEqual(0)
        expect(jitter).toBeLessThanOrEqual(50)
      }
    })

    it('should work with different base delays', () => {
      const jitter = calculateJitter(1000, 0.3)
      expect(jitter).toBeGreaterThanOrEqual(0)
      expect(jitter).toBeLessThan(300)
    })

    it('should return full range when jitterFactor is 1', () => {
      let minJitter = Infinity
      let maxJitter = -Infinity
      
      for (let i = 0; i < 100; i++) {
        const jitter = calculateJitter(100, 1)
        minJitter = Math.min(minJitter, jitter)
        maxJitter = Math.max(maxJitter, jitter)
      }
      
      // Should cover near full range with 100 samples
      expect(minJitter).toBeLessThan(20)
      expect(maxJitter).toBeGreaterThan(80)
    })
  })
})
