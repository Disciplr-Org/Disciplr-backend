import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { spawnSync } from 'node:child_process'
import { seedDemo } from '../../scripts/seed-demo.mjs'
import { PgStore } from '../../apilib/store.mjs'
import { testDatabase } from './database.mjs'

describe('demo seed production gate', () => {
  it('refuses production before acquiring a database connection', async () => {
    const pool = { connect: jest.fn() }
    await expect(seedDemo(pool, { env: { NODE_ENV: 'production' } })).rejects.toThrow('--force')
    expect(pool.connect).not.toHaveBeenCalled()
    const result = spawnSync(process.execPath, ['scripts/seed-demo.mjs'], {
      encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_ENV: 'production', DATABASE_URL: '' },
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Demo seeding refused in production')
  })

  it('allows the explicit force flag and rolls back failed inserts', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] })
    const release = jest.fn()
    const pool = { connect: async () => ({ query, release }) }
    await seedDemo(pool, { env: { NODE_ENV: 'production' }, force: true })
    expect(query.mock.calls.at(-1)[0]).toBe('COMMIT')
    query.mockRejectedValueOnce(new Error('begin failed'))
    await expect(seedDemo(pool)).rejects.toThrow('begin failed')
    expect(query.mock.calls.at(-1)[0]).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledTimes(2)
  })
})

const integration = process.env.TEST_DATABASE_URL ? describe : describe.skip
integration('explicit demo seed on real Postgres', () => {
  let fixture
  beforeAll(async () => {
    fixture = await testDatabase()
    await fixture.database.migrate.latest()
  }, 60000)
  afterAll(async () => { await fixture?.close() })

  it('leaves a new database empty during store initialization', async () => {
    await new PgStore(fixture.pool).init()
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM vaults')).rows[0].n).toBe(0)
  })

  it('runs npm run seed:demo twice with stable rows and preserves user edits across reinitialization', async () => {
    const run = () => {
      const result = spawnSync('npm', ['run', 'seed:demo'], { encoding: 'utf8', timeout: 15000,
        env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: fixture.url } })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' })
    }
    run()
    const before = (await fixture.pool.query('SELECT * FROM activity_log ORDER BY id')).rows
    expect(before).toHaveLength(6)
    await fixture.pool.query("UPDATE vaults SET name='My edited name', creator='edited-creator' WHERE id='vault-demo-001'")
    run()
    await new PgStore(fixture.pool).init()
    expect((await fixture.pool.query('SELECT * FROM activity_log ORDER BY id')).rows).toEqual(before)
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM vaults')).rows[0].n).toBe(3)
    expect((await fixture.pool.query('SELECT count(*)::int AS n FROM milestones')).rows[0].n).toBe(6)
    expect((await fixture.pool.query("SELECT name,creator FROM vaults WHERE id='vault-demo-001'")).rows[0])
      .toEqual({ name: 'My edited name', creator: 'edited-creator' })
  })
})
