import request from 'supertest'
import { app } from '../app.js'
import { db } from '../db/index.js'

describe('Transactions API', () => {
  let testUserId: string
  let testVaultId: string
  let testTransactionId: string

  beforeAll(async () => {
    // Create test user
    const user = await db('users').insert({
      email: 'test@example.com',
      password_hash: 'hashed_password'
    }).returning('*')
    testUserId = user[0].id

    // Create test vault
    const vault = await db('vaults').insert({
      id: 'test-vault-1234567890123456789012345678901234567890123456789012345678901234',
      creator: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
      amount: '100.0000000',
      start_timestamp: new Date(),
      end_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      success_destination: 'GDEST1234567890123456789012345678901234567890123456789012345678901',
      failure_destination: 'GFAIL1234567890123456789012345678901234567890123456789012345678901',
      status: 'active',
      user_id: testUserId
    }).returning('*')
    testVaultId = vault[0].id

    // Create test transaction
    const transaction = await db('transactions').insert({
      user_id: testUserId,
      vault_id: testVaultId,
      tx_hash: 'test_tx_hash_1234567890123456789012345678901234567890123456789012345678901234',
      type: 'creation',
      amount: '100.0000000',
      asset_code: null,
      from_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
      to_account: 'GDEST1234567890123456789012345678901234567890123456789012345678901',
      memo: 'Test transaction',
      stellar_ledger: 12345,
      stellar_timestamp: new Date(),
      explorer_url: 'https://stellar.expert/explorer/public/tx/test_tx_hash'
    }).returning('*')
    testTransactionId = transaction[0].id
  })

  afterAll(async () => {
    // Clean up test data
    await db('transactions').where('user_id', testUserId).del()
    await db('vaults').where('user_id', testUserId).del()
    await db('users').where('id', testUserId).del()
    await db.destroy()
  })

  describe('GET /api/transactions', () => {
    it('should return user transactions with authentication', async () => {
      const response = await request(app)
        .get('/api/transactions')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
      expect(Array.isArray(response.body.data)).toBe(true)
      expect(response.body.data.length).toBeGreaterThan(0)
      
      const transaction = response.body.data[0]
      expect(transaction).toHaveProperty('id')
      expect(transaction).toHaveProperty('vault_id')
      expect(transaction).toHaveProperty('type')
      expect(transaction).toHaveProperty('amount')
      expect(transaction).toHaveProperty('tx_hash')
      expect(transaction).toHaveProperty('explorer_url')
    })

    it('should filter transactions by type', async () => {
      const response = await request(app)
        .get('/api/transactions?type=creation')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data.every((tx: any) => tx.type === 'creation')).toBe(true)
    })

    it('should filter transactions by vault_id', async () => {
      const response = await request(app)
        .get(`/api/transactions?vault_id=${testVaultId}`)
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data.every((tx: any) => tx.vault_id === testVaultId)).toBe(true)
    })

    it('should paginate results using page parameter', async () => {
      const response = await request(app)
        .get('/api/transactions?page=1&limit=1')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.pagination.limit).toBe(1)
      expect(response.body.pagination.page).toBe(1)
      expect(response.body.data.length).toBeLessThanOrEqual(1)
    })

    it('should maintain stable ordering for identical timestamps', async () => {
      const now = new Date()
      // Insert two transactions with the same timestamp
      await db('transactions').insert([
        {
          user_id: testUserId,
          vault_id: testVaultId,
          tx_hash: 'same_ts_1',
          type: 'creation',
          amount: '10.00',
          from_account: 'GFROM',
          to_account: 'GTO',
          stellar_ledger: 100,
          stellar_timestamp: now,
          explorer_url: 'http://example.com/1'
        },
        {
          user_id: testUserId,
          vault_id: testVaultId,
          tx_hash: 'same_ts_2',
          type: 'creation',
          amount: '20.00',
          from_account: 'GFROM',
          to_account: 'GTO',
          stellar_ledger: 100,
          stellar_timestamp: now,
          explorer_url: 'http://example.com/2'
        }
      ])

      const res = await request(app)
        .get('/api/transactions?limit=10')
        .set('x-user-id', testUserId)
        .expect(200)

      const sameTsItems = res.body.data.filter((tx: any) => tx.tx_hash.startsWith('same_ts_'))
      expect(sameTsItems.length).toBe(2)
      
      // Should be ordered by ID (UUID) descending since timestamps are identical
      // We can't easily predict UUID order without knowing them, but we can verify consistency
      const order = sameTsItems.map((tx: any) => tx.id)
      const sortedOrder = [...order].sort().reverse()
      expect(order).toEqual(sortedOrder)
    })

    it('should require authentication', async () => {
      await request(app)
        .get('/api/transactions')
        .expect(401)
    })
  })

  describe('GET /api/transactions/:id', () => {
    it('should return specific transaction', async () => {
      const response = await request(app)
        .get(`/api/transactions/${testTransactionId}`)
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body).toHaveProperty('id', testTransactionId)
      expect(response.body).toHaveProperty('vault_id', testVaultId)
      expect(response.body).toHaveProperty('type')
      expect(response.body).toHaveProperty('amount')
    })

    it('should return 404 for non-existent transaction', async () => {
      await request(app)
        .get('/api/transactions/non-existent-id')
        .set('x-user-id', testUserId)
        .expect(404)
    })

    it('should require authentication', async () => {
      await request(app)
        .get(`/api/transactions/${testTransactionId}`)
        .expect(401)
    })
  })

  describe('GET /api/transactions/vault/:vaultId', () => {
    it('should return transactions for specific vault', async () => {
      const response = await request(app)
        .get(`/api/transactions/vault/${testVaultId}`)
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(Array.isArray(response.body.data)).toBe(true)
      expect(response.body.data.every((tx: any) => tx.vault_id === testVaultId)).toBe(true)
    })

    it('should return 404 for non-existent vault', async () => {
      await request(app)
        .get('/api/transactions/vault/non-existent-vault')
        .set('x-user-id', testUserId)
        .expect(404)
    })

    it('should require authentication', async () => {
      await request(app)
        .get(`/api/transactions/vault/${testVaultId}`)
        .expect(401)
    })
  })

  // ─── List Contract Tests for Cursor Pagination ────────────────────────────
  describe('GET /api/transactions - Cursor Pagination Contract', () => {
    beforeAll(async () => {
      // Create additional test transactions for pagination testing
      for (let i = 0; i < 5; i++) {
        await db('transactions').insert({
          user_id: testUserId,
          vault_id: testVaultId,
          tx_hash: `test_tx_hash_${i}_1234567890123456789012345678901234567890123456789012345678901234`,
          type: i % 2 === 0 ? 'creation' : 'transfer',
          amount: String(100 + i * 10),
          asset_code: 'XLM',
          from_account: 'GTEST1234567890123456789012345678901234567890123456789012345678901',
          to_account: 'GDEST1234567890123456789012345678901234567890123456789012345678901',
          memo: `Test transaction ${i}`,
          stellar_ledger: 12345 + i,
          stellar_timestamp: new Date(Date.now() - i * 1000),
          explorer_url: `https://stellar.expert/explorer/public/tx/test_tx_${i}`
        })
      }
    })

    it('validates cursor pagination structure', async () => {
      const response = await request(app)
        .get('/api/transactions')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body).toHaveProperty('data')
      expect(response.body).toHaveProperty('pagination')
      expect(response.body.pagination).toHaveProperty('limit')
      expect(response.body.pagination).toHaveProperty('has_more')
      expect(response.body.pagination).toHaveProperty('count')
      expect(typeof response.body.pagination.limit).toBe('number')
      expect(typeof response.body.pagination.has_more).toBe('boolean')
      expect(typeof response.body.pagination.count).toBe('number')
    })

    it('respects limit parameter', async () => {
      const response = await request(app)
        .get('/api/transactions?limit=3')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.pagination.limit).toBe(3)
      expect(response.body.data.length).toBeLessThanOrEqual(3)
    })

    it('enforces maximum limit of 100', async () => {
      const response = await request(app)
        .get('/api/transactions?limit=200')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.pagination.limit).toBeLessThanOrEqual(100)
    })

    it('returns 400 for invalid cursor', async () => {
      const response = await request(app)
        .get('/api/transactions?cursor=invalid_cursor_value')
        .set('x-user-id', testUserId)

      expect(response.status).toBe(400)
      expect(response.body.error.code).toBe('BAD_REQUEST')
    })
  })

  // ─── Sorting Contract Tests ───────────────────────────────────────────────
  describe('GET /api/transactions - Sorting Contract', () => {
    it('rejects invalid sort field with 400', async () => {
      const response = await request(app)
        .get('/api/transactions?sortBy=invalid_field')
        .set('x-user-id', testUserId)

      expect(response.status).toBe(400)
      expect(response.body.error).toBeDefined()
    })

    it('accepts valid sort fields', async () => {
      const validFields = ['created_at', 'stellar_timestamp', 'amount', 'type', 'stellar_ledger']

      for (const field of validFields) {
        const response = await request(app)
          .get(`/api/transactions?sortBy=${field}`)
          .set('x-user-id', testUserId)
          .expect(200)

        expect(response.body.data).toBeDefined()
      }
    })

    it('supports descending order', async () => {
      const response = await request(app)
        .get('/api/transactions?sortBy=stellar_timestamp&sortOrder=desc')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data).toBeDefined()
      // Verify data is sorted (newest first for desc)
      if (response.body.data.length >= 2) {
        const first = new Date(response.body.data[0].stellar_timestamp).getTime()
        const second = new Date(response.body.data[1].stellar_timestamp).getTime()
        expect(first).toBeGreaterThanOrEqual(second)
      }
    })

    it('supports ascending order', async () => {
      const response = await request(app)
        .get('/api/transactions?sortBy=stellar_timestamp&sortOrder=asc')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data).toBeDefined()
    })
  })

  // ─── Filtering Contract Tests ─────────────────────────────────────────────
  describe('GET /api/transactions - Filtering Contract', () => {
    it('ignores non-allowed filter parameters', async () => {
      const response = await request(app)
        .get('/api/transactions?nonexistentFilter=value')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data).toBeDefined()
    })

    it('accepts all valid filter fields', async () => {
      const validFilters = ['type', 'vault_id', 'date_from', 'date_to', 'amount_min', 'amount_max']

      for (const filter of validFilters) {
        const value = filter === 'type' ? 'creation' :
                      filter === 'vault_id' ? testVaultId :
                      filter.startsWith('date') ? '2024-01-01T00:00:00.000Z' :
                      '50'

        const response = await request(app)
          .get(`/api/transactions?${filter}=${value}`)
          .set('x-user-id', testUserId)
          .expect(200)

        expect(response.body.data).toBeDefined()
      }
    })

    it('filters by type correctly', async () => {
      const response = await request(app)
        .get('/api/transactions?type=creation')
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data.every((tx: any) => tx.type === 'creation')).toBe(true)
    })

    it('filters by vault_id correctly', async () => {
      const response = await request(app)
        .get(`/api/transactions?vault_id=${testVaultId}`)
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data.every((tx: any) => tx.vault_id === testVaultId)).toBe(true)
    })

    it('supports multiple filter parameters', async () => {
      const response = await request(app)
        .get(`/api/transactions?type=creation&vault_id=${testVaultId}`)
        .set('x-user-id', testUserId)
        .expect(200)

      expect(response.body.data.every((tx: any) =>
        tx.type === 'creation' && tx.vault_id === testVaultId
      )).toBe(true)
    })
  })

  // ─── Security Contract Tests ──────────────────────────────────────────────
  describe('GET /api/transactions - Security Contract', () => {
    it('requires authentication', async () => {
      const response = await request(app)
        .get('/api/transactions')

      expect(response.status).toBe(401)
      expect(response.body.error.code).toBe('UNAUTHORIZED')
    })

    it('cannot access other user transactions', async () => {
      // Create another user and their transaction
      const otherUser = await db('users').insert({
        email: 'other@example.com',
        password_hash: 'hashed_password'
      }).returning('*')

      const otherVault = await db('vaults').insert({
        id: 'other-vault-1234567890123456789012345678901234567890123456789012345678901234',
        creator: 'GOTHER1234567890123456789012345678901234567890123456789012345678901',
        amount: '200.0000000',
        start_timestamp: new Date(),
        end_timestamp: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        success_destination: 'GDEST1234567890123456789012345678901234567890123456789012345678901',
        failure_destination: 'GFAIL1234567890123456789012345678901234567890123456789012345678901',
        status: 'active',
        user_id: otherUser[0].id
      }).returning('*')

      await db('transactions').insert({
        user_id: otherUser[0].id,
        vault_id: otherVault[0].id,
        tx_hash: 'other_tx_hash_1234567890123456789012345678901234567890123456789012345678901234',
        type: 'creation',
        amount: '200.0000000',
        asset_code: null,
        from_account: 'GOTHER1234567890123456789012345678901234567890123456789012345678901',
        to_account: 'GDEST1234567890123456789012345678901234567890123456789012345678901',
        memo: 'Other user transaction',
        stellar_ledger: 99999,
        stellar_timestamp: new Date(),
        explorer_url: 'https://stellar.expert/explorer/public/tx/other_tx'
      })

      // Get transactions as original user
      const response = await request(app)
        .get('/api/transactions')
        .set('x-user-id', testUserId)
        .expect(200)

      // Should not see other user's transaction
      const otherUserTx = response.body.data.find(
        (tx: any) => tx.stellar_ledger === 99999
      )
      expect(otherUserTx).toBeUndefined()

      // Cleanup
      await db('transactions').where('user_id', otherUser[0].id).del()
      await db('vaults').where('user_id', otherUser[0].id).del()
      await db('users').where('id', otherUser[0].id).del()
    })

    it('cannot sort by sensitive internal fields', async () => {
      const response = await request(app)
        .get('/api/transactions?sortBy=user_id')
        .set('x-user-id', testUserId)

      expect(response.status).toBe(400)
    })
  })
})
