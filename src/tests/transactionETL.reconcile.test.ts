import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { logVaultDriftAnomaly } from '../security/abuse-monitor.js'

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('vault reconciliation - abuse-monitor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('logVaultDriftAnomaly', () => {
    it('logs vault_missing_onchain event', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      logVaultDriftAnomaly('vault_missing_onchain', {
        vaultId: 'vault-123',
        persistedStatus: 'active',
      })

      const logCall = logSpy.mock.calls[0][0] as string
      expect(logCall).toContain('vault.vault_missing_onchain')
      expect(logCall).toContain('vault-123')
      expect(logCall).toContain('active')

      logSpy.mockRestore()
    })

    it('logs vault_state_drift event', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      logVaultDriftAnomaly('vault_state_drift', {
        vaultId: 'vault-456',
        driftedFields: ['status', 'amount'],
        persisted: { status: 'active', amount: '1000' },
        onChain: { status: 'completed', amount: '2000' },
      })

      const logCall = logSpy.mock.calls[0][0] as string
      expect(logCall).toContain('vault.vault_state_drift')
      expect(logCall).toContain('vault-456')
      expect(logCall).toContain('status')
      expect(logCall).toContain('amount')

      logSpy.mockRestore()
    })

    it('logs vault_reconciliation_error event', () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})

      logVaultDriftAnomaly('vault_reconciliation_error', {
        vaultId: 'vault-789',
        error: 'RPC timeout',
      })

      const logCall = logSpy.mock.calls[0][0] as string
      expect(logCall).toContain('vault.vault_reconciliation_error')
      expect(logCall).toContain('vault-789')
      expect(logCall).toContain('RPC timeout')

      logSpy.mockRestore()
    })
  })
})
