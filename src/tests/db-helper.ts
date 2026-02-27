import knex, { Knex } from 'knex'

let testDb: Knex | null = null

export const getTestDb = (): Knex => {
  if (!testDb) {
    const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL

    if (!testDbUrl) {
      throw new Error('TEST_DATABASE_URL or DATABASE_URL must be set for integration tests')
    }

    testDb = knex({
      client: 'pg',
      connection: testDbUrl,
      pool: { min: 1, max: 5 },
    })
  }

  return testDb
}

export const cleanupTestDb = async (): Promise<void> => {
  if (testDb) {
    await testDb.destroy()
    testDb = null
  }
}

export const resetTestTables = async (db: Knex): Promise<void> => {
  await db.raw('TRUNCATE TABLE api_keys CASCADE')
}
