import { TransactionETLService } from '../services/transactionETL.js'
import { db } from '../db/index.js'
import type { ETLConfig } from '../types/transactions.js'

describe('TransactionETLService', () => {
  let etlService: TransactionETLService
  let testUserId: string
  let testVaultId: string

  const mockConfig: ETLConfig = {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    networkPassphrase: 'Test SDF Network ; September 2015',
    batchSize: 10,
    maxRetries: 3
  }

  beforeAll(async () => {
    etlService = new TransactionETLService(mockConfig)

    // Create test user
    const user = await db('users').insert({
      email: 'etl-test@example.com',
      password_hash: 'hashed_password'
    }).returning('*')
    testUserId = user[0].id

    // Create test vault
    const vault = await db('vaults').insert({
      id: 'etl-test-vault-123456789012345678901234567890123456789012345678901234567890',
      creator: 'GETL1234567890123456789012345678901234567890123456789012345678901',
      amount: '50.0000000',
      start_timestamp: new Date(),
      end_timestamp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      success_destination: 'GETLDEST1234567890123456789012345678901234567890123456789012345678901',
      failure_destination: 'GETLFAIL1234567890123456789012345678901234567890123456789012345678901',
      status: 'active',
      user_id: testUserId
    }).returning('*')
    testVaultId = vault[0].id
  })

  afterAll(async () => {
    // Clean up test data
    await db('transactions').where('user_id', testUserId).del()
    await db('vaults').where('user_id', testUserId).del()
    await db('users').where('id', testUserId).del()
    await db.destroy()
  })

  describe('transformHorizonOperation', () => {
    it('should transform Horizon operation record correctly', () => {
      const mockRecord = {
        id: '123456789',
        type: 'payment',
        transaction_hash: 'abcdef1234567890123456789012345678901234567890123456789012345678901234567890',
        created_at: '2026-02-26T10:00:00Z',
        transaction_successful: true,
        source_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
        amount: '100.0000000',
        asset_code: 'XLM',
        asset_type: 'native',
        from: 'GFROM1234567890123456789012345678901234567890123456789012345678901',
        to: 'GTO1234567890123456789012345678901234567890123456789012345678901',
        ledger: 12345,
        fee_paid: 100,
        memo: 'test memo',
        memo_type: 'text'
      }

      const result = (etlService as any).transformHorizonOperation(mockRecord)

      expect(result).toEqual({
        id: '123456789',
        type: 'payment',
        transaction_hash: 'abcdef1234567890123456789012345678901234567890123456789012345678901234567890',
        created_at: '2026-02-26T10:00:00Z',
        transaction_successful: true,
        source_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
        amount: '100.0000000',
        asset_code: 'XLM',
        asset_type: 'native',
        from: 'GFROM1234567890123456789012345678901234567890123456789012345678901',
        to: 'GTO1234567890123456789012345678901234567890123456789012345678901',
        ledger: 12345,
        fee_paid: 100,
        memo: 'test memo',
        memo_type: 'text'
      })
    })
  })

  describe('mapOperationToTransactionType', () => {
    it('should map create_account to creation', () => {
      const operation = { type: 'create_account' }
      const result = (etlService as any).mapOperationToTransactionType(operation)
      expect(result).toBe('creation')
    })

    it('should map payment to validation when going to verifier', () => {
      const operation = { type: 'payment', to: 'verifier_account' }
      const result = (etlService as any).mapOperationToTransactionType(operation)
      expect(result).toBe('validation')
    })

    it('should map payment to release when going to success destination', () => {
      const operation = { type: 'payment', to: 'success_destination' }
      const result = (etlService as any).mapOperationToTransactionType(operation)
      expect(result).toBe('release')
    })

    it('should map manage_data cancel to cancel', () => {
      const operation = { type: 'manage_data', name: 'vault_cancel' }
      const result = (etlService as any).mapOperationToTransactionType(operation)
      expect(result).toBe('cancel')
    })

    it('should return null for unknown operation types', () => {
      const operation = { type: 'unknown_operation' }
      const result = (etlService as any).mapOperationToTransactionType(operation)
      expect(result).toBeNull()
    })
  })

  describe('transformOperationToTransaction', () => {
    it('should transform operation to transaction record', async () => {
      const operation = {
        id: '123456789',
        type: 'payment',
        transaction_hash: 'abcdef1234567890123456789012345678901234567890123456789012345678901234567890',
        created_at: '2026-02-26T10:00:00Z',
        transaction_successful: true,
        source_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
        amount: '100.0000000',
        asset_code: 'XLM',
        asset_type: 'native',
        from: 'GFROM1234567890123456789012345678901234567890123456789012345678901',
        to: 'GTO1234567890123456789012345678901234567890123456789012345678901',
        ledger: 12345,
        fee_paid: 100,
        memo: 'test memo',
        memo_type: 'text'
      }

      const vaultReference = {
        id: testVaultId,
        user_id: testUserId,
        creator: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
        verifier: 'GVERIFIER1234567890123456789012345678901234567890123456789012345678901',
        success_destination: 'GTO1234567890123456789012345678901234567890123456789012345678901',
        failure_destination: 'GFAIL1234567890123456789012345678901234567890123456789012345678901'
      }

      const result = await (etlService as any).transformOperationToTransaction(operation, vaultReference)

      expect(result).toMatchObject({
        user_id: testUserId,
        vault_id: testVaultId,
        tx_hash: 'abcdef1234567890123456789012345678901234567890123456789012345678901234567890',
        type: 'release',
        amount: '100.0000000',
        asset_code: 'XLM',
        from_account: 'GFROM1234567890123456789012345678901234567890123456789012345678901',
        to_account: 'GTO1234567890123456789012345678901234567890123456789012345678901',
        memo: 'test memo',
        stellar_ledger: 12345,
        explorer_url: 'https://stellar.expert/explorer/public/tx/abcdef1234567890123456789012345678901234567890123456789012345678901234567890'
      })
    })
  })

  describe('saveTransactions', () => {
    it('should save transactions without duplicates', async () => {
      const transactions = [
        {
          id: crypto.randomUUID(),
          user_id: testUserId,
          vault_id: testVaultId,
          tx_hash: 'test_save_tx_1234567890123456789012345678901234567890123456789012345678901234',
          type: 'creation' as const,
          amount: '100.0000000',
          asset_code: null,
          from_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
          to_account: 'GTO1234567890123456789012345678901234567890123456789012345678901',
          memo: 'test save',
          created_at: new Date(),
          stellar_ledger: 12345,
          stellar_timestamp: new Date(),
          explorer_url: 'https://stellar.expert/explorer/public/tx/test_save_tx'
        }
      ]

      await (etlService as any).saveTransactions(transactions)

      const saved = await db('transactions')
        .where('tx_hash', 'test_save_tx_1234567890123456789012345678901234567890123456789012345678901234')
        .first()

      expect(saved).toBeTruthy()
      expect(saved.user_id).toBe(testUserId)
      expect(saved.vault_id).toBe(testVaultId)

      // Try to save again - should not create duplicate
      await (etlService as any).saveTransactions(transactions)

      const count = await db('transactions')
        .where('tx_hash', 'test_save_tx_1234567890123456789012345678901234567890123456789012345678901234')
        .count('* as count')

      expect(parseInt(String(count[0].count))).toBe(1)
    })
  })
})
