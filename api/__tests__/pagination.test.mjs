// Cursor pagination tests for GET /vaults and GET /transactions.
import { describe, test, expect, beforeEach, afterAll } from 'bun:test'
import { createApp } from '../index.mjs'
import { MemoryStore, PgStore, resetStore } from '../../apilib/store.mjs'
import { encodeCursor, decodeCursor, parseLimit } from '../../apilib/pagination.mjs'

const CREATOR = 'GBVAQKGA5P4TIZSZJBS5AW3XNJOTYG6I3Y5CLIGCBBUZDHMVF7YE7XCQ'
const VERIFIER = 'GDLYZ73G3GEF36HBLEBFXOXAP5IXJDRQCRG47JCKR4XAXNOFCU44NZT2'

async function seedVaults(app, count) {
  const vaults = []
  const baseTime = new Date('2026-01-01T00:00:00.000Z').getTime()
  
  for (let i = 0; i < count; i++) {
    // Create vaults with staggered timestamps
    const startDate = new Date(baseTime + i * 60000).toISOString()
    const res = await app.inject({
      method: 'POST',
      url: '/api/vaults',
      payload: {
        name: `Vault ${i}`,
        creator: CREATOR,
        verifier: VERIFIER,
        amount: 1000 + i,
        startDate,
        endDate: new Date(baseTime + i * 60000 + 86400000).toISOString(),
        milestones: [{ title: `Milestone ${i}`, amount: 1000 + i, dueDate: startDate }],
      },
    })
    expect(res.statusCode).toBe(201)
    vaults.push(JSON.parse(res.body).data)
  }
  return vaults
}

describe('Pagination helpers', () => {
  test('encodeCursor and decodeCursor round-trip', () => {
    const timestamp = '2026-04-01T12:00:00.000Z'
    const id = 'vault-abc123'
    const cursor = encodeCursor(timestamp, id)
    expect(cursor).toBeDefined()
    const decoded = decodeCursor(cursor)
    expect(decoded.timestamp).toBe(timestamp)
    expect(decoded.id).toBe(id)
  })

  test('decodeCursor rejects malformed input', () => {
    expect(decodeCursor('notbase64url!!')).toBeNull()
    expect(decodeCursor('dGVzdA==')).toBeNull() // valid base64 but wrong format
    expect(decodeCursor('')).toBeNull()
    expect(decodeCursor(null)).toBeNull()
  })

  test('decodeCursor rejects invalid timestamp', () => {
    const bad = Buffer.from('invalid-date|vault-123', 'utf8').toString('base64url')
    expect(decodeCursor(bad)).toBeNull()
  })

  test('decodeCursor rejects injection attempts', () => {
    const injection = Buffer.from('2026-01-01T00:00:00.000Z|vault-123; DROP TABLE vaults', 'utf8').toString('base64url')
    expect(decodeCursor(injection)).toBeNull()
  })

  test('parseLimit validates range', () => {
    expect(parseLimit('25')).toBe(25)
    expect(parseLimit('1')).toBe(1)
    expect(parseLimit('100')).toBe(100)
    expect(parseLimit('0')).toBeNull()
    expect(parseLimit('101')).toBeNull()
    expect(parseLimit('abc')).toBeNull()
    expect(parseLimit('-5')).toBeNull()
  })
})

async function runTests(storeName, getStore) {
  describe(`Pagination (${storeName})`, () => {
    let app

    beforeEach(async () => {
      await resetStore()
      app = createApp(getStore)
    })

    test('default limit returns 25 items with nextCursor when more exist', async () => {
      await seedVaults(app, 30)
      
      const res = await app.inject({ method: 'GET', url: '/api/vaults' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data).toHaveLength(25)
      expect(body.count).toBe(25)
      expect(body.page.limit).toBe(25)
      expect(body.page.nextCursor).toBeDefined()
    })

    test('following nextCursor returns remaining items', async () => {
      await seedVaults(app, 30)
      
      const page1 = await app.inject({ method: 'GET', url: '/api/vaults?limit=10' })
      const body1 = JSON.parse(page1.body)
      expect(body1.data).toHaveLength(10)
      expect(body1.page.nextCursor).toBeDefined()
      
      const page2 = await app.inject({ method: 'GET', url: `/api/vaults?limit=10&cursor=${body1.page.nextCursor}` })
      const body2 = JSON.parse(page2.body)
      expect(body2.data).toHaveLength(10)
      expect(body2.page.nextCursor).toBeDefined()
      
      const page3 = await app.inject({ method: 'GET', url: `/api/vaults?limit=10&cursor=${body2.page.nextCursor}` })
      const body3 = JSON.parse(page3.body)
      expect(body3.data).toHaveLength(10)
      expect(body3.page.nextCursor).toBeNull()
    })

    test('pagination returns items in descending (createdAt, id) order', async () => {
      await seedVaults(app, 50)
      
      const allItems = []
      let cursor = null
      
      for (let i = 0; i < 5; i++) {
        const url = cursor ? `/api/vaults?limit=10&cursor=${cursor}` : '/api/vaults?limit=10'
        const res = await app.inject({ method: 'GET', url })
        const body = JSON.parse(res.body)
        allItems.push(...body.data)
        cursor = body.page.nextCursor
        if (!cursor) break
      }
      
      expect(allItems).toHaveLength(50)
      
      // Verify descending order
      for (let i = 1; i < allItems.length; i++) {
        const prev = allItems[i - 1]
        const curr = allItems[i]
        const cmp = prev.createdAt.localeCompare(curr.createdAt)
        if (cmp === 0) {
          expect(prev.id > curr.id).toBe(true)
        } else {
          expect(cmp > 0).toBe(true)
        }
      }
    })

    test('no duplicate or skipped items across pages', async () => {
      await seedVaults(app, 50)
      
      const allIds = new Set()
      let cursor = null
      
      for (let i = 0; i < 10; i++) {
        const url = cursor ? `/api/vaults?limit=10&cursor=${cursor}` : '/api/vaults?limit=10'
        const res = await app.inject({ method: 'GET', url })
        const body = JSON.parse(res.body)
        
        body.data.forEach((v) => {
          expect(allIds.has(v.id)).toBe(false)
          allIds.add(v.id)
        })
        
        cursor = body.page.nextCursor
        if (!cursor) break
      }
      
      expect(allIds.size).toBe(50)
    })

    test('limit=0 returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/vaults?limit=0' })
      expect(res.statusCode).toBe(400)
    })

    test('limit=101 returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/vaults?limit=101' })
      expect(res.statusCode).toBe(400)
    })

    test('limit=abc returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/vaults?limit=abc' })
      expect(res.statusCode).toBe(400)
    })

    test('tampered cursor returns 400', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/vaults?cursor=invalid!!!' })
      expect(res.statusCode).toBe(400)
    })

    test('last page has nextCursor: null', async () => {
      await seedVaults(app, 10)
      
      const res = await app.inject({ method: 'GET', url: '/api/vaults?limit=20' })
      const body = JSON.parse(res.body)
      expect(body.data).toHaveLength(10)
      expect(body.page.nextCursor).toBeNull()
    })

    test('filters work with pagination', async () => {
      await seedVaults(app, 30)
      
      const res = await app.inject({ method: 'GET', url: `/api/vaults?creator=${CREATOR}&limit=15` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data).toHaveLength(15)
      expect(body.page.nextCursor).toBeDefined()
    })

    test('/transactions pagination works', async () => {
      const vaults = await seedVaults(app, 30)
      
      const res = await app.inject({ method: 'GET', url: '/api/transactions?limit=10' })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body.data.length).toBeLessThanOrEqual(10)
      expect(body.page).toBeDefined()
      expect(body.page.limit).toBe(10)
    })

    test('/transactions vaultId filter with pagination', async () => {
      const vaults = await seedVaults(app, 5)
      const vaultId = vaults[0].id
      
      const res = await app.inject({ method: 'GET', url: `/api/transactions?vaultId=${vaultId}&limit=10` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      body.data.forEach((a) => expect(a.vaultId).toBe(vaultId))
    })

    test('vault detail still returns activity without pagination params', async () => {
      const vaults = await seedVaults(app, 1)
      const res = await app.inject({ method: 'GET', url: `/api/vaults/${vaults[0].id}` })
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(Array.isArray(body.data.activity)).toBe(true)
    })
  })
}

runTests('memory', async () => new MemoryStore())

if (process.env.DATABASE_URL) {
  const pg = await import('pg')
  const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL })
  runTests('postgres', async () => new PgStore(pool))
  afterAll(async () => { await pool.end() })
}
