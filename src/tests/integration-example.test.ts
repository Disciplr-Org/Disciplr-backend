import { getTestDb, resetTestTables } from './db-helper.js'

describe('Database Integration Example', () => {
  const db = getTestDb()

  beforeEach(async () => {
    await resetTestTables(db)
  })

  it('connects to test database', async () => {
    const result = await db.raw('SELECT 1 as value')
    expect(result.rows[0].value).toBe(1)
  })

  it('can query api_keys table', async () => {
    const result = await db('api_keys').select('*')
    expect(Array.isArray(result)).toBe(true)
  })
})
