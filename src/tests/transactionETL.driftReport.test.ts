import { jest, describe, it, expect, beforeEach, afterEach, mock } from 'bun:test'

const mockUpdate = jest.fn().mockResolvedValue(true)
const mockFirst = jest.fn()
const mockSelect = jest.fn().mockReturnThis()
const mockWhere = jest.fn().mockReturnThis()

const mockKnexChain: any = {
  where: mockWhere,
  select: mockSelect,
  first: mockFirst,
  update: mockUpdate,
  limit: jest.fn().mockReturnThis(),
  then: jest.fn(),
}

const mockDb = jest.fn(() => mockKnexChain)

mock.module('../db/index.js', () => ({
  default: mockDb,
}))

const mockSorobanClient = {
  getVault: jest.fn(),
}

mock.module('../services/soroban.js', () => ({
  getSorobanConfig: jest.fn().mockReturnValue({ contractId: 'test-contract' }),
  getSorobanClient: jest.fn().mockReturnValue(mockSorobanClient),
}))

const mockAuditLog = jest.fn().mockResolvedValue({ id: 'audit-log-1', created_at: new Date().toISOString() })
mock.module('../lib/audit-logs.js', () => ({
  createAuditLog: mockAuditLog,
}))

const mockLogVaultDriftAnomaly = jest.fn()
mock.module('../security/abuse-monitor.js', () => ({
  logVaultDriftAnomaly: mockLogVaultDriftAnomaly,
}))

const { TransactionETLService } = await import('../services/transactionETL.js')

describe('TransactionETLService Drift Report & Auto-Repair', () => {
  let etl: any

  beforeEach(() => {
    jest.clearAllMocks()
    etl = new TransactionETLService({ horizonUrl: 'https://test', batchSize: 50 })
  })

  describe('reconcileVaults', () => {
    it('returns a drift report with driftedVaults array', async () => {
      mockKnexChain.then.mockImplementationOnce((resolve: any) => resolve([
        { id: 'v1', status: 'active', amount: '100', verifier: 'v-user', success_destination: 's1', failure_destination: 'f1' },
      ]))

      mockSorobanClient.getVault.mockResolvedValueOnce({
        status: 'completed', // Drifted!
        amount: '100',
        verifier: 'v-user',
        successDestination: 's1',
        failureDestination: 'f1',
      })

      const report = await etl.reconcileVaults()

      expect(report.totalVaults).toBe(1)
      expect(report.driftDetected).toBe(1)
      expect(report.driftedVaults.length).toBe(1)
      expect(report.driftedVaults[0].vaultId).toBe('v1')
      expect(report.driftedVaults[0].driftedFields).toContain('status')
    })
  })

  describe('autoRepairVault', () => {
    it('does not repair disputed vaults', async () => {
      mockFirst.mockResolvedValueOnce({ id: 'v2', status: 'disputed' })

      const result = await etl.autoRepairVault('v2', 'admin-1')
      
      expect(result.success).toBe(false)
      expect(result.message).toMatch(/dispute/i)
      expect(mockUpdate).not.toHaveBeenCalled()
    })

    it('successfully repairs drifted vaults and logs audit', async () => {
      mockFirst.mockResolvedValueOnce({
        id: 'v3', status: 'active', amount: '100', verifier: 'v-user'
      })

      mockSorobanClient.getVault.mockResolvedValueOnce({
        status: 'completed', // Drifted
        amount: '100',
        verifier: 'v-user',
      })

      const result = await etl.autoRepairVault('v3', 'admin-1')

      expect(result.success).toBe(true)
      expect(result.repairedFields).toContain('status')
      
      expect(mockUpdate).toHaveBeenCalledWith({ status: 'completed' })
      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'admin.vault.auto_repair',
        target_id: 'v3',
        actor_user_id: 'admin-1'
      }))
    })

    it('does not update if no drift', async () => {
      mockFirst.mockResolvedValueOnce({
        id: 'v4', status: 'active', amount: '100', verifier: 'v-user'
      })

      mockSorobanClient.getVault.mockResolvedValueOnce({
        status: 'active',
        amount: '100',
        verifier: 'v-user',
      })

      const result = await etl.autoRepairVault('v4', 'admin-1')

      expect(result.success).toBe(true)
      expect(result.message).toMatch(/no drift/i)
      expect(mockUpdate).not.toHaveBeenCalled()
    })
  })
})
