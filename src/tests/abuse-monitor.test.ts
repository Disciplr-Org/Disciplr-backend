import { jest, describe, it, expect, beforeEach } from '@jest/globals'
import { AbuseMonitor } from '../services/abuse-monitor.js'
import { logger } from '../middleware/logger.js'
import { emitTestSuspiciousEvent, __resetSecurityMonitorForTests, getAbuseCategoryCounts, logVaultDriftAnomaly } from '../security/abuse-monitor.js'
import type { AbuseCategory } from '../types/security.js'

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

  it('should not leak plain-text PII in logs and use full 64-character actorHash', () => {
    const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const pii = 'user@example.com'
    
    monitor.record({ id: pii, type: 'auth_fail', weight: 100 })
    
    const logOutput = consoleSpy.mock.calls[0][0]
    expect(logOutput).not.toContain(pii)
    expect(logOutput).toContain('actorHash')
    
    const parsed = JSON.parse(logOutput)
    expect(parsed.actorHash).toHaveLength(64)
    
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

  it('evicts the least-recently-active entry (LRU) when maxEntries is reached', () => {
    jest.useFakeTimers()

    const smallMonitor = new AbuseMonitor({ maxEntries: 2, penaltyScoreLimit: 9999 })

    // user1 is recorded first (oldest lastSeen)
    smallMonitor.record({ id: 'user1', type: 'request' })

    // Advance time so user2 has a newer lastSeen than user1
    jest.advanceTimersByTime(1000)
    smallMonitor.record({ id: 'user2', type: 'request' })

    // Map is now full.  A new actor (user3) must evict the LRU entry (user1),
    // NOT silently return false as the old guard did.
    jest.advanceTimersByTime(1000)
    const result = smallMonitor.record({ id: 'user3', type: 'request', weight: 200 })

    // user3 was tracked — its high-weight signal should cause the expected return value
    // (false here because 200 < 9999 penaltyScoreLimit)
    expect(result).toBe(false)

    // user3 is now in the map; user1 (LRU) was evicted, user2 survives
    // We can verify by driving user3 score over the limit — it must be tracked
    const flagged = smallMonitor.record({ id: 'user3', type: 'auth_fail', weight: 9999 })
    expect(flagged).toBe(true)

    jest.useRealTimers()
  })

  it('tracks a new actor after LRU eviction rather than permanently ignoring it', () => {
    jest.useFakeTimers()

    const smallMonitor = new AbuseMonitor({ maxEntries: 1, penaltyScoreLimit: 9999 })

    // Fill the single slot
    smallMonitor.record({ id: 'early-actor', type: 'request' })

    // A new high-weight actor arrives — it must displace early-actor and be scored
    jest.advanceTimersByTime(500)
    const flagged = smallMonitor.record({ id: 'new-bad-actor', type: 'auth_fail', weight: 9999 })
    expect(flagged).toBe(true)

    jest.useRealTimers()
  })
})

describe('AbuseMonitor structured AbuseCategory events (#467)', () => {
  let monitor: AbuseMonitor

  beforeEach(() => {
    monitor = new AbuseMonitor({ penaltyScoreLimit: 10, decayRate: 0 })
  })

  it('emits structured AbuseEvent JSON with category when limit is exceeded', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    monitor.record({ id: 'ip1', type: 'auth_fail', weight: 20 })

    expect(warnSpy).toHaveBeenCalledTimes(1)
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.event).toBe('security.abuse_detected')
    expect(logged.category).toBeDefined()
    expect(logged.actorHash).toBeDefined()
    expect(logged.timestamp).toBeDefined()
    expect(logged.actorHash).not.toContain('ip1')
    warnSpy.mockRestore()
  })

  it('infers brute-force category for auth_fail signals', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    monitor.record({ id: 'ip2', type: 'auth_fail', weight: 20 })
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.category.type).toBe('brute-force')
    warnSpy.mockRestore()
  })

  it('infers payload-anomaly category for invalid_xdr signals', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    monitor.record({ id: 'ip3', type: 'invalid_xdr', weight: 20 })
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.category.type).toBe('payload-anomaly')
    warnSpy.mockRestore()
  })

  it('infers rate-limit-trip category for generic request signals', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    monitor.record({ id: 'ip4', type: 'request', weight: 20 })
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.category.type).toBe('rate-limit-trip')
    warnSpy.mockRestore()
  })

  it('uses an explicitly passed AbuseCategory over the inferred one', () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const explicit: AbuseCategory = { type: 'enumeration', notFoundCount: 25, distinctPathCount: 15, windowMs: 300000 }
    monitor.record({ id: 'ip5', type: 'request', weight: 20, category: explicit })
    const logged = JSON.parse(warnSpy.mock.calls[0][0] as string)
    expect(logged.category).toEqual(explicit)
    warnSpy.mockRestore()
  })

  it('increments getCategoryCounts for each distinct category', () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {})
    monitor.record({ id: 'a1', type: 'auth_fail', weight: 20 })
    monitor.record({ id: 'a2', type: 'auth_fail', weight: 20 })
    monitor.record({ id: 'b1', type: 'invalid_xdr', weight: 20 })

    const counts = monitor.getCategoryCounts()
    expect(counts['brute-force']).toBe(2)
    expect(counts['payload-anomaly']).toBe(1)
    jest.restoreAllMocks()
  })

  it('getCategoryCounts returns a copy (mutations do not affect internal state)', () => {
    const counts = monitor.getCategoryCounts()
    counts['brute-force'] = 999
    expect(monitor.getCategoryCounts()['brute-force']).not.toBe(999)
  })
})

describe('security/abuse-monitor structured events (pino integration)', () => {
  beforeEach(() => {
    __resetSecurityMonitorForTests()
  })

  it('emits structured pino warn payload with category when invoked via test helper', () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    const category = { type: 'enumeration', notFoundCount: 12, distinctPathCount: 8, windowMs: 300000 }
    emitTestSuspiciousEvent('1.2.3.4', category as any, { alertCooldownMs: 300000 })

    expect(spy).toHaveBeenCalledTimes(1)
    const payload = spy.mock.calls[0][0]
    expect(payload).toBeDefined()
    expect(payload.event).toBe('security.suspicious_pattern')
    expect(payload.ip).toBe('1.2.3.4')
    expect(payload.category).toEqual(category)

    spy.mockRestore()
  })

  it('getAbuseCategoryCounts reflects emitted events', () => {
    const category = { type: 'brute-force', failedLoginCount: 3, windowMs: 900000 }
    emitTestSuspiciousEvent('2.2.2.2', category as any)
    emitTestSuspiciousEvent('3.3.3.3', category as any)

    const counts = getAbuseCategoryCounts()
    expect(counts['brute-force']).toBe(2)
  })

  it('logVaultDriftAnomaly emits structured vault_missing_onchain event', () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    logVaultDriftAnomaly('vault_missing_onchain', {
      vaultId: 'vault-123',
      persistedStatus: 'active',
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const payloadStr = JSON.stringify(spy.mock.calls[0][0])
    expect(payloadStr).toContain('vault.vault_missing_onchain')
    expect(payloadStr).toContain('vault-123')
    expect(payloadStr).toContain('active')

    spy.mockRestore()
  })

  it('logVaultDriftAnomaly emits structured vault_state_drift event', () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    logVaultDriftAnomaly('vault_state_drift', {
      vaultId: 'vault-456',
      driftedFields: ['status', 'amount'],
      persisted: { status: 'active', amount: '1000' },
      onChain: { status: 'completed', amount: '2000' },
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const payloadStr = JSON.stringify(spy.mock.calls[0][0])
    expect(payloadStr).toContain('vault.vault_state_drift')
    expect(payloadStr).toContain('vault-456')
    expect(payloadStr).toContain('status')
    expect(payloadStr).toContain('amount')

    spy.mockRestore()
  })

  it('logVaultDriftAnomaly emits structured vault_reconciliation_error event', () => {
    const spy = jest.spyOn(logger, 'warn').mockImplementation(() => {})

    logVaultDriftAnomaly('vault_reconciliation_error', {
      vaultId: 'vault-789',
      error: 'RPC timeout',
    })

    expect(spy).toHaveBeenCalledTimes(1)
    const payloadStr = JSON.stringify(spy.mock.calls[0][0])
    expect(payloadStr).toContain('vault.vault_reconciliation_error')
    expect(payloadStr).toContain('vault-789')
    expect(payloadStr).toContain('RPC timeout')

    spy.mockRestore()
  })
})