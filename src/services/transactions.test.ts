import { describe, it, expect, beforeEach, vi, type MockedFunction } from '@jest/globals'
import { TransactionETLService, type VaultEvent, type TransactionRecord } from './transactions.js'

// Mock the database connection
const mockDb = {
  transactions: vi.fn().mockReturnThis(),
  insert: vi.fn().mockReturnThis(),
  onConflict: vi.fn().mockReturnThis(),
  ignore: vi.fn().mockResolvedValue(undefined),
  where: vi.fn().mockReturnThis(),
  select: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  offset: vi.fn().mockReturnThis(),
  first: vi.fn().mockResolvedValue(null),
  clone: vi.fn().mockReturnThis(),
  clearSelect: vi.fn().mockReturnThis(),
  clearOrder: vi.fn().mockReturnThis(),
  count: vi.fn().mockReturnThis()
}

// Mock Stellar SDK
const mockHorizonServer = {
  transactions: vi.fn().mockReturnThis(),
  forAccount: vi.fn().mockReturnThis(),
  order: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  call: vi.fn().mockResolvedValue({
    records: []
  })
}

vi.mock('../db/connection.js', () => ({
  db: vi.fn(() => mockDb)
}))

vi.mock('@stellar/stellar-sdk', () => ({
  Horizon: {
    Server: vi.fn(() => mockHorizonServer)
  }
}))

describe('TransactionETLService', () => {
  let service: TransactionETLService

  beforeEach(() => {
    vi.clearAllMocks()
    service = new TransactionETLService()
  })

  describe('mapHorizonEventToTransaction', () => {
    it('should map a vault event to a transaction record', async () => {
      const vaultEvent: VaultEvent = {
        vault_id: 'test-vault-id',
        type: 'creation',
        amount: '100.0000000',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        transaction_hash: 'test-tx-hash',
        metadata: {
          operation_id: 'op-123',
          operation_type: 'create_account'
        }
      }

      const transaction = await service.mapHorizonEventToTransaction(vaultEvent)

      expect(transaction).toEqual({
        id: expect.stringMatching(/^tx-test-vault-id-\d+-[a-z0-9]+$/),
        vault_id: 'test-vault-id',
        type: 'creation',
        amount: '100.0000000',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        stellar_transaction_hash: 'test-tx-hash',
        stellar_explorer_url: 'https://steexp.com/tx/test-tx-hash',
        metadata: {
          operation_id: 'op-123',
          operation_type: 'create_account'
        }
      })
    })

    it('should handle events without transaction hash', async () => {
      const vaultEvent: VaultEvent = {
        vault_id: 'test-vault-id',
        type: 'validation',
        timestamp: new Date('2024-01-01T00:00:00Z')
      }

      const transaction = await service.mapHorizonEventToTransaction(vaultEvent)

      expect(transaction.stellar_transaction_hash).toBeUndefined()
      expect(transaction.stellar_explorer_url).toBeUndefined()
    })
  })

  describe('determineOperationType', () => {
    it('should determine operation type correctly', () => {
      const serviceInstance = new TransactionETLService()
      
      // Access private method for testing
      const determineType = (serviceInstance as any).determineOperationType.bind(serviceInstance)

      expect(determineType({ type: 'create_account' })).toBe('creation')
      expect(determineType({ type: 'payment', amount: '0.0000001' })).toBe('validation')
      expect(determineType({ type: 'payment', amount: '100.0000000' })).toBe('release')
      expect(determineType({ type: 'manage_data' })).toBe('redirect')
      expect(determineType({ type: 'set_options' })).toBe('cancel')
      expect(determineType({ type: 'unknown' })).toBe('creation')
    })
  })

  describe('extractAmount', () => {
    it('should extract amount from different operation types', () => {
      const serviceInstance = new TransactionETLService()
      const extractAmount = (serviceInstance as any).extractAmount.bind(serviceInstance)

      expect(extractAmount({ type: 'payment', amount: '100.0000000' })).toBe('100.0000000')
      expect(extractAmount({ type: 'create_account', starting_balance: '50.0000000' })).toBe('50.0000000')
      expect(extractAmount({ type: 'manage_data' })).toBeUndefined()
    })
  })

  describe('isVaultOperation', () => {
    it('should identify vault operations correctly', () => {
      const serviceInstance = new TransactionETLService()
      const isVaultOp = (serviceInstance as any).isVaultOperation.bind(serviceInstance)
      const vaultId = 'test-vault-id'

      expect(isVaultOp({ source_account: vaultId }, vaultId)).toBe(true)
      expect(isVaultOp({ type: 'payment', destination: vaultId }, vaultId)).toBe(true)
      expect(isVaultOp({ type: 'create_account', destination: vaultId }, vaultId)).toBe(true)
      expect(isVaultOp({ source_account: 'other-account' }, vaultId)).toBe(false)
      expect(isVaultOp({ type: 'payment', destination: 'other-account' }, vaultId)).toBe(false)
    })
  })

  describe('getTransactions', () => {
    it('should get transactions with filters', async () => {
      const mockTransactions: TransactionRecord[] = [
        {
          id: 'tx-1',
          vault_id: 'vault-1',
          type: 'creation',
          amount: '100.0000000',
          timestamp: new Date('2024-01-01T00:00:00Z')
        }
      ]

      mockDb.count.mockResolvedValue([{ total: 1 }])
      mockDb.mockResolvedValue(mockTransactions)

      const result = await service.getTransactions({
        vaultId: 'vault-1',
        type: 'creation',
        page: 1,
        pageSize: 20
      })

      expect(mockDb.where).toHaveBeenCalledWith('vault_id', 'vault-1')
      expect(mockDb.where).toHaveBeenCalledWith('type', 'creation')
      expect(result.transactions).toEqual(mockTransactions)
      expect(result.total).toBe(1)
    })

    it('should handle pagination correctly', async () => {
      mockDb.count.mockResolvedValue([{ total: 50 }])
      mockDb.mockResolvedValue([])

      await service.getTransactions({
        page: 2,
        pageSize: 10
      })

      expect(mockDb.limit).toHaveBeenCalledWith(10)
      expect(mockDb.offset).toHaveBeenCalledWith(10) // (2-1) * 10
    })
  })

  describe('getTransactionById', () => {
    it('should return transaction when found', async () => {
      const mockTransaction: TransactionRecord = {
        id: 'tx-1',
        vault_id: 'vault-1',
        type: 'creation',
        timestamp: new Date('2024-01-01T00:00:00Z')
      }

      mockDb.first.mockResolvedValue(mockTransaction)

      const result = await service.getTransactionById('tx-1')

      expect(mockDb.where).toHaveBeenCalledWith('id', 'tx-1')
      expect(result).toEqual(mockTransaction)
    })

    it('should return null when transaction not found', async () => {
      mockDb.first.mockResolvedValue(null)

      const result = await service.getTransactionById('nonexistent')

      expect(result).toBeNull()
    })
  })

  describe('saveTransactions', () => {
    it('should save transactions to database', async () => {
      const transactions: TransactionRecord[] = [
        {
          id: 'tx-1',
          vault_id: 'vault-1',
          type: 'creation',
          timestamp: new Date('2024-01-01T00:00:00Z')
        }
      ]

      await service.saveTransactions(transactions)

      expect(mockDb.insert).toHaveBeenCalledWith(transactions)
      expect(mockDb.onConflict).toHaveBeenCalled()
      expect(mockDb.ignore).toHaveBeenCalled()
    })

    it('should handle database errors', async () => {
      mockDb.insert.mockImplementation(() => {
        throw new Error('Database error')
      })

      const transactions: TransactionRecord[] = [
        {
          id: 'tx-1',
          vault_id: 'vault-1',
          type: 'creation',
          timestamp: new Date('2024-01-01T00:00:00Z')
        }
      ]

      await expect(service.saveTransactions(transactions)).rejects.toThrow('Database error')
    })
  })
})
