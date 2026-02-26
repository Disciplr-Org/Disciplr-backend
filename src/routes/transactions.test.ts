import request from 'supertest'
import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { app } from '../app.js'
import { TransactionETLService, type TransactionRecord } from '../services/transactions.js'

// Mock the TransactionETLService
jest.mock('../services/transactions.js')

const vi = jest

describe('Transactions API', () => {
  let mockETLService: any

  beforeEach(() => {
    vi.clearAllMocks()
    
    mockETLService = {
      getTransactions: vi.fn(),
      getTransactionById: vi.fn(),
      processVaultEvents: vi.fn()
    }

    const { TransactionETLService: MockedETLService } = vi.mocked('../services/transactions.js')
    vi.mocked(MockedETLService).mockImplementation(() => mockETLService)
  })

  describe('GET /api/transactions', () => {
    it('should return paginated transactions', async () => {
      const mockTransactions: TransactionRecord[] = [
        {
          id: 'tx-1',
          vault_id: 'vault-1',
          type: 'creation',
          amount: '100.0000000',
          timestamp: new Date('2024-01-01T00:00:00Z'),
          stellar_transaction_hash: 'hash-1',
          stellar_explorer_url: 'https://steexp.com/tx/hash-1'
        },
        {
          id: 'tx-2',
          vault_id: 'vault-2',
          type: 'validation',
          timestamp: new Date('2024-01-02T00:00:00Z')
        }
      ]

      mockETLService.getTransactions.mockResolvedValue({
        transactions: mockTransactions,
        total: 25
      })

      const response = await request(app)
        .get('/api/transactions')
        .expect(200)

      expect(response.body).toEqual({
        data: mockTransactions,
        pagination: {
          page: 1,
          pageSize: 20,
          total: 25
        }
      })

      expect(mockETLService.getTransactions).toHaveBeenCalledWith({
        vaultId: undefined,
        type: undefined,
        dateFrom: undefined,
        dateTo: undefined,
        amount: undefined,
        page: 1,
        pageSize: 20
      })
    })

    it('should apply filters correctly', async () => {
      mockETLService.getTransactions.mockResolvedValue({
        transactions: [],
        total: 0
      })

      await request(app)
        .get('/api/transactions?vaultId=vault-123&type=creation&dateFrom=2024-01-01&dateTo=2024-01-31&amount=100.0000000&page=2&pageSize=10')
        .expect(200)

      expect(mockETLService.getTransactions).toHaveBeenCalledWith({
        vaultId: 'vault-123',
        type: 'creation',
        dateFrom: '2024-01-01',
        dateTo: '2024-01-31',
        amount: '100.0000000',
        page: 2,
        pageSize: 10
      })
    })

    it('should handle service errors', async () => {
      mockETLService.getTransactions.mockRejectedValue(new Error('Database error'))

      const response = await request(app)
        .get('/api/transactions')
        .expect(500)

      expect(response.body).toEqual({
        error: 'Internal server error'
      })
    })

    it('should validate pagination parameters', async () => {
      const response = await request(app)
        .get('/api/transactions?page=0&pageSize=101')
        .expect(400)

      expect(response.body.error).toContain('Invalid query parameters')
    })
  })

  describe('GET /api/transactions/:id', () => {
    it('should return a single transaction', async () => {
      const mockTransaction: TransactionRecord = {
        id: 'tx-1',
        vault_id: 'vault-1',
        type: 'creation',
        amount: '100.0000000',
        timestamp: new Date('2024-01-01T00:00:00Z'),
        stellar_transaction_hash: 'hash-1',
        stellar_explorer_url: 'https://steexp.com/tx/hash-1'
      }

      mockETLService.getTransactionById.mockResolvedValue(mockTransaction)

      const response = await request(app)
        .get('/api/transactions/tx-1')
        .expect(200)

      expect(response.body).toEqual(mockTransaction)
      expect(mockETLService.getTransactionById).toHaveBeenCalledWith('tx-1')
    })

    it('should return 404 for non-existent transaction', async () => {
      mockETLService.getTransactionById.mockResolvedValue(null)

      const response = await request(app)
        .get('/api/transactions/nonexistent')
        .expect(404)

      expect(response.body).toEqual({
        error: 'Transaction not found'
      })
    })

    it('should handle service errors', async () => {
      mockETLService.getTransactionById.mockRejectedValue(new Error('Database error'))

      const response = await request(app)
        .get('/api/transactions/tx-1')
        .expect(500)

      expect(response.body).toEqual({
        error: 'Internal server error'
      })
    })
  })

  describe('POST /api/transactions/sync/:vaultId', () => {
    it('should sync transactions for a vault', async () => {
      const mockSyncedTransactions: TransactionRecord[] = [
        {
          id: 'tx-1',
          vault_id: 'vault-123',
          type: 'creation',
          amount: '100.0000000',
          timestamp: new Date('2024-01-01T00:00:00Z')
        }
      ]

      mockETLService.processVaultEvents.mockResolvedValue(mockSyncedTransactions)

      const response = await request(app)
        .post('/api/transactions/sync/vault-123')
        .expect(200)

      expect(response.body).toEqual({
        message: 'Synced 1 transactions for vault vault-123',
        data: mockSyncedTransactions
      })

      expect(mockETLService.processVaultEvents).toHaveBeenCalledWith('vault-123')
    })

    it('should handle sync errors', async () => {
      mockETLService.processVaultEvents.mockRejectedValue(new Error('Horizon API error'))

      const response = await request(app)
        .post('/api/transactions/sync/vault-123')
        .expect(500)

      expect(response.body).toEqual({
        error: 'Failed to sync vault transactions'
      })
    })

    it('should handle empty transaction list', async () => {
      mockETLService.processVaultEvents.mockResolvedValue([])

      const response = await request(app)
        .post('/api/transactions/sync/vault-123')
        .expect(200)

      expect(response.body).toEqual({
        message: 'Synced 0 transactions for vault vault-123',
        data: []
      })
    })
  })

  describe('Edge Cases', () => {
    it('should handle malformed filter parameters', async () => {
      const response = await request(app)
        .get('/api/transactions?type=invalid-type')
        .expect(400)

      expect(response.body.error).toContain('Invalid query parameters')
    })

    it('should handle large page numbers', async () => {
      mockETLService.getTransactions.mockResolvedValue({
        transactions: [],
        total: 0
      })

      await request(app)
        .get('/api/transactions?page=999999')
        .expect(200)

      expect(mockETLService.getTransactions).toHaveBeenCalledWith(
        expect.objectContaining({
          page: 999999
        })
      )
    })

    it('should handle special characters in vault IDs', async () => {
      mockETLService.getTransactionById.mockResolvedValue(null)

      await request(app)
        .get('/api/transactions/vault-abc_123-def')
        .expect(404)

      expect(mockETLService.getTransactionById).toHaveBeenCalledWith('vault-abc_123-def')
    })
  })
})
