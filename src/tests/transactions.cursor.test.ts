import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import request from 'supertest'
import { app } from '../app.js'
import { db } from '../db/index.js'
import { encodeCursor } from '../utils/pagination.js'

describe('Transactions Cursor Pagination Stability', () => {
  let testUserId: string
  let testVaultId: string

  beforeAll(async () => {
    // Create test user
    const user = await db('users').insert({
      email: 'cursor-test@example.com',
      password_hash: 'hashed'
    }).returning('*')
    testUserId = user[0].id

    // Create test vault
    const vault = await db('vaults').insert({
      id: 'vault-cursor-test-12345678901234567890123456789012345678901234567',
      creator: 'GTEST_CURSOR',
      amount: '1000',
      end_timestamp: new Date(Date.now() + 1000000),
      success_destination: 'GDEST',
      failure_destination: 'GFAIL',
      status: 'active',
      user_id: testUserId
    }).returning('*')
    testVaultId = vault[0].id

    // Create 5 initial transactions with distinct timestamps (descending)
    for (let i = 0; i < 5; i++) {
        await db('transactions').insert({
            user_id: testUserId,
            vault_id: testVaultId,
            tx_hash: `hash_initial_${i}`,
            type: 'creation',
            amount: (100 + i).toString(),
            from_account: 'GFROM',
            to_account: 'GTO',
            stellar_ledger: 1000 + i,
            stellar_timestamp: new Date(Date.now() - (i * 10000)), // 10s apart
            explorer_url: 'http://example.com'
        })
    }
  })

  afterAll(async () => {
    await db('transactions').where('user_id', testUserId).del()
    await db('vaults').where('user_id', testUserId).del()
    await db('users').where('id', testUserId).del()
    await db.destroy()
  })

  it('should maintain stable results when a new record is inserted concurrently', async () => {
    // 1. Fetch first page (3 items)
    const res1 = await request(app)
      .get('/api/transactions?limit=3')
      .set('x-user-id', testUserId)
      .expect(200)
    
    expect(res1.body.data.length).toBe(3)
    const page1Ids = res1.body.data.map((tx: any) => tx.id)
    const cursor = res1.body.pagination.next_cursor
    expect(cursor).toBeDefined()

    // 2. Insert a NEW transaction that would shift indices if using offset
    // Newest timestamp (now)
    await db('transactions').insert({
        user_id: testUserId,
        vault_id: testVaultId,
        tx_hash: 'hash_concurrent_new',
        type: 'creation',
        amount: '999',
        from_account: 'GFROM',
        to_account: 'GTO',
        stellar_ledger: 2000,
        stellar_timestamp: new Date(), // Newest
        explorer_url: 'http://example.com'
    })

    // 3. Fetch second page using cursor from first page
    const res2 = await request(app)
      .get(`/api/transactions?limit=3&cursor=${cursor}`)
      .set('x-user-id', testUserId)
      .expect(200)

    const page2Ids = res2.body.data.map((tx: any) => tx.id)

    // Verification:
    // - No duplicates (nothing from page 1 appears in page 2)
    const duplicates = page1Ids.filter((id: string) => page2Ids.includes(id))
    expect(duplicates.length).toBe(0)

    // - No skips: since we had 5 items, took 3, and then items were added "above", 
    //   we should get the remaining 2 original items.
    expect(res2.body.data.length).toBe(2)
  })

  it('should handle invalid cursors gracefully', async () => {
    const res = await request(app)
      .get('/api/transactions?cursor=invalid-base64-or-format')
      .set('x-user-id', testUserId)
      .expect(400)
    
    expect(res.body.error).toBe('Invalid cursor')
  })
})
