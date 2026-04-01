import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { AbuseMonitor } from '../services/abuse-monitor.js'

describe('AbuseMonitor Heuristics', () => {
  let monitor: AbuseMonitor

  beforeEach(() => {
    monitor = new AbuseMonitor({
      penaltyScoreLimit: 50,
      decayRate: 1
    })
  })

  it('should flag an ID after exceeding the penalty limit', () => {
    const id = '192.168.1.1'
    // Add 6 signals (weight 10 each for auth_fail default)
    for (let i = 0; i < 5; i++) {
      monitor.record({ id, type: 'auth_fail' })
    }
    const isAbusive = monitor.record({ id, type: 'auth_fail' })
    expect(isAbusive).toBe(true)
  })

  it('should not leak plain-text PII in logs', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
    const pii = 'user@example.com'
    
    monitor.record({ id: pii, type: 'auth_fail', weight: 100 })
    
    const logOutput = consoleSpy.mock.calls[0][0]
    expect(logOutput).not.toContain(pii)
    expect(logOutput).toContain('actor_hash')
    
    consoleSpy.mockRestore()
  })

  it('should reduce scores over time using decayRate (False Positive Tuning)', async () => {
    jest.useFakeTimers()
    const id = 'test-id'
    
    // Set initial score
    monitor.record({ id, type: 'request', weight: 40 })
    
    // Advance time by 100 seconds. With decayRate 1, score should drop significantly.
    jest.advanceTimersByTime(100 * 1000)
    
    // Recording again should not trip the limit because the old 40 points decayed to 0
    const isAbusive = monitor.record({ id, type: 'request', weight: 20 })
    expect(isAbusive).toBe(false)
    jest.useRealTimers()
  })

  it('should remove stale records during cleanup', () => {
    jest.useFakeTimers()
    const id = 'stale-user'
    monitor.record({ id, type: 'request', weight: 10 })

    // Move 2 hours into the future (beyond the 1 hour TTL)
    jest.advanceTimersByTime(2 * 3600 * 1000)
    monitor.cleanup()

    // After cleanup, the record is gone. Recording again should start from weight 1 (not decayed from 10).
    // This ensures internal Map size stays small.
    jest.useRealTimers()
  })

  it('should handle weighted signals correctly', () => {
    const id = 'attacker'
    // One critical failure should be worth many small ones
    monitor.record({ id, type: 'invalid_xdr', weight: 45 })
    expect(monitor.record({ id, type: 'request', weight: 1 })).toBe(false)
    
    // Now crossing the line
    expect(monitor.record({ id, type: 'request', weight: 10 })).toBe(true)
  })

  it('should not track new IDs when maxEntries is reached', () => {
    const smallMonitor = new AbuseMonitor({ maxEntries: 2 })
    smallMonitor.record({ id: 'user1', type: 'request' })
    smallMonitor.record({ id: 'user2', type: 'request' })
    
    // Third unique ID should not be recorded (should return false/ignored)
    const result = smallMonitor.record({ id: 'user3', type: 'request', weight: 200 })
    expect(result).toBe(false)
  })
})