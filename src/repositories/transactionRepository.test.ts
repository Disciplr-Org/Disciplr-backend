import { jest } from '@jest/globals'
import {
  TransactionRepository,
  TransactionValidationError,
  TransactionAuthorizationError,
  validateTransactionInput,
  validateTransactionFilters,
  clampLimit,
  clampOffset,
} from './transactionRepository.js'
import { encodeCursor } from '../utils/pagination.js'

describe('TransactionRepository — Invariants & Authorization Boundaries', () => {
  let mockDb: any
  let queryBuilder: any

  beforeEach(() => {
    queryBuilder = {
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'tx-created-1', amount: '100.0000000' }]),
      where: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      offset: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      leftJoin: jest.fn().mockReturnThis(),
      count: jest.fn().mockReturnThis(),
      clone: jest.fn().mockReturnThis(),
      first: jest.fn(),
      then: jest.fn((resolve: any) => resolve([])),
    }

    const dbFn: any = jest.fn(() => queryBuilder)
    dbFn.fn = { now: jest.fn(() => '2026-08-30T00:00:00.000Z') }
    mockDb = dbFn
  })

  describe('validateTransactionInput', () => {
    const validTx = {
      user_id: 'user-123',
      vault_id: '00000000-0000-0000-0000-000000000001',
      tx_hash: '3389e9f0f73b404b45dc55b18382315cb49ac9f2d5feb686ed97f08917546761',
      type: 'creation' as const,
      amount: '100.0000000',
      stellar_ledger: 12345,
      stellar_timestamp: new Date('2026-08-30T00:00:00.000Z'),
    }

    it('passes for valid transaction inputs', () => {
      expect(() => validateTransactionInput(validTx)).not.toThrow()
    })

    it('rejects missing or empty user_id', () => {
      expect(() => validateTransactionInput({ ...validTx, user_id: '' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, user_id: '   ' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, user_id: undefined })).toThrow(TransactionValidationError)
    })

    it('rejects missing or empty vault_id', () => {
      expect(() => validateTransactionInput({ ...validTx, vault_id: '' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, vault_id: undefined })).toThrow(TransactionValidationError)
    })

    it('rejects missing, empty, or overly long tx_hash', () => {
      expect(() => validateTransactionInput({ ...validTx, tx_hash: '' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, tx_hash: 'a'.repeat(300) })).toThrow(TransactionValidationError)
    })

    it('rejects invalid transaction types', () => {
      expect(() => validateTransactionInput({ ...validTx, type: 'invalid_type' as any })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, type: undefined as any })).toThrow(TransactionValidationError)
    })

    it('rejects negative, NaN, or non-finite amounts', () => {
      expect(() => validateTransactionInput({ ...validTx, amount: '-10.0' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, amount: 'NaN' })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, amount: 'invalid-number' })).toThrow(TransactionValidationError)
    })

    it('rejects negative or non-integer stellar_ledger', () => {
      expect(() => validateTransactionInput({ ...validTx, stellar_ledger: -1 })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, stellar_ledger: 1.5 })).toThrow(TransactionValidationError)
      expect(() => validateTransactionInput({ ...validTx, stellar_ledger: NaN })).toThrow(TransactionValidationError)
    })
  })

  describe('validateTransactionFilters', () => {
    it('passes for valid filter values', () => {
      expect(() =>
        validateTransactionFilters({
          type: 'release',
          amountMin: '10',
          amountMax: '100',
          dateFrom: new Date('2026-01-01'),
          dateTo: new Date('2026-02-01'),
        }),
      ).not.toThrow()
    })

    it('rejects invalid transaction type in filter', () => {
      expect(() => validateTransactionFilters({ type: 'fake_type' })).toThrow(TransactionValidationError)
    })

    it('rejects amountMin > amountMax', () => {
      expect(() => validateTransactionFilters({ amountMin: '500', amountMax: '100' })).toThrow(TransactionValidationError)
    })

    it('rejects negative amount filter values', () => {
      expect(() => validateTransactionFilters({ amountMin: '-5' })).toThrow(TransactionValidationError)
    })

    it('rejects dateFrom > dateTo', () => {
      expect(() =>
        validateTransactionFilters({
          dateFrom: new Date('2026-05-01'),
          dateTo: new Date('2026-01-01'),
        }),
      ).toThrow(TransactionValidationError)
    })
  })

  describe('Limit & Offset Clamping', () => {
    it('clamps limit between 1 and 100 with default 20', () => {
      expect(clampLimit(undefined)).toBe(20)
      expect(clampLimit(0)).toBe(1)
      expect(clampLimit(-10)).toBe(1)
      expect(clampLimit(50)).toBe(50)
      expect(clampLimit(500)).toBe(100)
      expect(clampLimit(NaN)).toBe(20)
    })

    it('clamps offset to non-negative integer with default 0', () => {
      expect(clampOffset(undefined)).toBe(0)
      expect(clampOffset(-5)).toBe(0)
      expect(clampOffset(10)).toBe(10)
      expect(clampOffset(NaN)).toBe(0)
    })
  })

  describe('create', () => {
    it('validates input and creates record', async () => {
      const repo = new TransactionRepository(mockDb)
      const validTx = {
        user_id: 'user-1',
        vault_id: 'vault-1',
        tx_hash: 'tx-hash-1',
        type: 'creation' as const,
        amount: '50.0',
      }

      const result = await repo.create(validTx)
      expect(mockDb).toHaveBeenCalledWith('transactions')
      expect(queryBuilder.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-1',
          vault_id: 'vault-1',
          tx_hash: 'tx-hash-1',
          type: 'creation',
          amount: '50.0',
        }),
      )
      expect(result).toEqual({ id: 'tx-created-1', amount: '100.0000000' })
    })
  })

  describe('listWithCursor', () => {
    it('rejects missing user_id with TransactionAuthorizationError', async () => {
      const repo = new TransactionRepository(mockDb)
      await expect(repo.listWithCursor('', 20)).rejects.toThrow(TransactionAuthorizationError)
      await expect(repo.listWithCursor('   ', 20)).rejects.toThrow(TransactionAuthorizationError)
    })

    it('rejects malformed cursor with TransactionValidationError', async () => {
      const repo = new TransactionRepository(mockDb)
      await expect(repo.listWithCursor('user-1', 20, 'invalid!base64!cursor')).rejects.toThrow(TransactionValidationError)
    })

    it('queries with user_id scope and valid cursor', async () => {
      const repo = new TransactionRepository(mockDb)
      const validCursor = encodeCursor(new Date('2026-08-30T00:00:00Z'), 'tx-1')

      queryBuilder.then = jest.fn((resolve: any) =>
        resolve([
          {
            id: 'tx-1',
            stellar_timestamp: '2026-08-30T00:00:00Z',
            amount: '10',
          },
        ]),
      )

      const result = await repo.listWithCursor('user-1', 10, validCursor, { type: 'release' })
      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
      expect(result.data).toHaveLength(1)
    })
  })

  describe('findByHash & findById', () => {
    it('scopes findByHash to userId when provided', async () => {
      const repo = new TransactionRepository(mockDb)
      queryBuilder.first.mockResolvedValue({ id: 'tx-1', tx_hash: 'hash-1', user_id: 'user-1' })

      const result = await repo.findByHash('hash-1', 'user-1')
      expect(queryBuilder.where).toHaveBeenCalledWith({ tx_hash: 'hash-1' })
      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
      expect(result).toBeDefined()
    })

    it('rejects empty txHash in findByHash', async () => {
      const repo = new TransactionRepository(mockDb)
      await expect(repo.findByHash('')).rejects.toThrow(TransactionValidationError)
    })

    it('scopes findById to userId when provided', async () => {
      const repo = new TransactionRepository(mockDb)
      queryBuilder.first.mockResolvedValue({ id: 'tx-1', user_id: 'user-1' })

      const result = await repo.findById('tx-1', 'user-1')
      expect(queryBuilder.where).toHaveBeenCalledWith({ id: 'tx-1' })
      expect(queryBuilder.where).toHaveBeenCalledWith({ user_id: 'user-1' })
      expect(result).toBeDefined()
    })
  })

  describe('listByVault', () => {
    it('throws authorization error if user does not own vault and is not member', async () => {
      const repo = new TransactionRepository(mockDb)
      queryBuilder.first.mockResolvedValue(null) // Vault not found or no access

      await expect(repo.listByVault('vault-1', 'user-1', 20)).rejects.toThrow(TransactionAuthorizationError)
    })

    it('fetches transactions when user is authorized for the vault', async () => {
      const repo = new TransactionRepository(mockDb)
      queryBuilder.first.mockResolvedValue({ id: 'vault-1' }) // Access confirmed
      queryBuilder.then = jest.fn((resolve: any) =>
        resolve([{ id: 'tx-vault-1', vault_id: 'vault-1', stellar_timestamp: '2026-08-30T00:00:00Z' }]),
      )

      const result = await repo.listByVault('vault-1', 'user-1', 20)
      expect(result.data).toHaveLength(1)
      expect(result.data[0].id).toBe('tx-vault-1')
    })
  })
})
