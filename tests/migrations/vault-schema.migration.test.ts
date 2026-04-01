/**
 * Tests for db/migrations/20260227000000_fix_vault_schema.cjs
 *
 * Requires DATABASE_URL pointing to a writable PostgreSQL test database.
 * Tests are skipped gracefully when DATABASE_URL is not set.
 *
 * Run: npm test -- --testPathPattern=vault-schema.migration
 */

// knex is a devDependency — import via createRequire to avoid ESM resolution issues
import { createRequire } from 'module'
import { randomUUID } from 'crypto'

const require = createRequire(import.meta.url)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const knexLib = require('knex') as { default: (config: object) => Knex }
type Knex = {
  raw: (sql: string, bindings?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>
  migrate: { latest: (opts: object) => Promise<void> }
  destroy: () => Promise<void>
}
const knex = (config: object): Knex => knexLib.default(config) as unknown as Knex

// ─── helpers ──────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL

/** Skip all tests if no DATABASE_URL is configured. */
const describeWithDb = DB_URL ? describe : describe.skip

let db: Knex

/** Load the migration module fresh each time (avoid module cache issues). */
function loadMigration() {
  // Clear require cache so each test gets a clean module
  const migPath = require.resolve('../../db/migrations/20260227000000_fix_vault_schema.cjs')
  delete require.cache[migPath]
  return require(migPath) as { up: (k: Knex) => Promise<void>; down: (k: Knex) => Promise<void> }
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const { rows } = await db.raw(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  return rows.length > 0
}

async function indexExists(indexName: string): Promise<boolean> {
  const { rows } = await db.raw(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?`,
    [indexName],
  )
  return rows.length > 0
}

async function getVaultColumns(): Promise<string[]> {
  const { rows } = await db.raw(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'vaults'
     ORDER BY column_name`,
  )
  return rows.map((r: Record<string, unknown>) => r.column_name as string)
}

/** Insert a minimal vault row using the vaultStore.ts column list. */
async function insertVaultRow(overrides: Record<string, unknown> = {}) {
  const id = randomUUID()
  await db.raw(
    `INSERT INTO vaults
       (id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator, status)
     VALUES (?, ?, NOW(), NOW() + INTERVAL '1 day', ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.amount ?? '1000.0000000',
      overrides.verifier ?? 'GVERIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      overrides.success_destination ?? 'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      overrides.failure_destination ?? 'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      overrides.creator ?? null,
      overrides.status ?? 'draft',
    ],
  )
  return id
}

// ─── setup / teardown ─────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!DB_URL) return
  db = knex({ client: 'pg', connection: DB_URL })
  // Run all prior migrations so the baseline schema exists
  await db.migrate.latest({ directory: 'db/migrations', extension: 'cjs' })
})

afterAll(async () => {
  if (db) await db.destroy()
})

/** Ensure migration is rolled back before each test so we start clean. */
beforeEach(async () => {
  if (!DB_URL) return
  const migration = loadMigration()
  try {
    await migration.down(db)
  } catch {
    // Ignore — migration may not have been applied yet
  }
})

// ─── Unit tests: exports.up ───────────────────────────────────────────────────

describeWithDb('exports.up — column alignment', () => {
  beforeEach(async () => {
    const { up } = loadMigration()
    await up(db)
  })

  afterEach(async () => {
    const { down } = loadMigration()
    await down(db)
  })

  it('renames start_timestamp to start_date', async () => {
    expect(await columnExists('vaults', 'start_date')).toBe(true)
    expect(await columnExists('vaults', 'start_timestamp')).toBe(false)
  })

  it('renames end_timestamp to end_date', async () => {
    expect(await columnExists('vaults', 'end_date')).toBe(true)
    expect(await columnExists('vaults', 'end_timestamp')).toBe(false)
  })

  it('adds verifier column', async () => {
    expect(await columnExists('vaults', 'verifier')).toBe(true)
  })

  it('adds updated_at column', async () => {
    expect(await columnExists('vaults', 'updated_at')).toBe(true)
  })

  it('drops idx_vaults_end_timestamp and creates idx_vaults_end_date', async () => {
    expect(await indexExists('idx_vaults_end_timestamp')).toBe(false)
    expect(await indexExists('idx_vaults_end_date')).toBe(true)
  })

  it('allows INSERT with status = draft', async () => {
    const id = await insertVaultRow({ status: 'draft' })
    const { rows } = await db.raw('SELECT status FROM vaults WHERE id = ?', [id])
    expect(rows[0].status).toBe('draft')
  })

  it('defaults status to draft when not supplied', async () => {
    const id = randomUUID()
    await db.raw(
      `INSERT INTO vaults
         (id, amount, start_date, end_date, verifier, success_destination, failure_destination, creator)
       VALUES (?, ?, NOW(), NOW() + INTERVAL '1 day', ?, ?, ?, ?)`,
      [
        id,
        '500.0000000',
        'GVERIFIERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
        null,
      ],
    )
    const { rows } = await db.raw('SELECT status FROM vaults WHERE id = ?', [id])
    expect(rows[0].status).toBe('draft')
  })

  it('INSERT using exact vaultStore.ts column list succeeds', async () => {
    const id = await insertVaultRow()
    const { rows } = await db.raw('SELECT id FROM vaults WHERE id = ?', [id])
    expect(rows[0].id).toBe(id)
  })

  it('milestones table has sort_order column', async () => {
    expect(await columnExists('milestones', 'sort_order')).toBe(true)
  })

  it('milestones table has amount column', async () => {
    expect(await columnExists('milestones', 'amount')).toBe(true)
  })

  it('milestones table has due_date column', async () => {
    expect(await columnExists('milestones', 'due_date')).toBe(true)
  })
})

// ─── Unit tests: exports.down ─────────────────────────────────────────────────

describeWithDb('exports.down — rollback', () => {
  beforeEach(async () => {
    const { up } = loadMigration()
    await up(db)
  })

  it('restores start_timestamp and removes start_date', async () => {
    const { down } = loadMigration()
    await down(db)
    expect(await columnExists('vaults', 'start_timestamp')).toBe(true)
    expect(await columnExists('vaults', 'start_date')).toBe(false)
  })

  it('restores end_timestamp and removes end_date', async () => {
    const { down } = loadMigration()
    await down(db)
    expect(await columnExists('vaults', 'end_timestamp')).toBe(true)
    expect(await columnExists('vaults', 'end_date')).toBe(false)
  })

  it('removes verifier column', async () => {
    const { down } = loadMigration()
    await down(db)
    expect(await columnExists('vaults', 'verifier')).toBe(false)
  })

  it('removes updated_at column', async () => {
    const { down } = loadMigration()
    await down(db)
    expect(await columnExists('vaults', 'updated_at')).toBe(false)
  })

  it('restores idx_vaults_end_timestamp and removes idx_vaults_end_date', async () => {
    const { down } = loadMigration()
    await down(db)
    expect(await indexExists('idx_vaults_end_timestamp')).toBe(true)
    expect(await indexExists('idx_vaults_end_date')).toBe(false)
  })

  it('INSERT with status = draft fails after rollback', async () => {
    const { down } = loadMigration()
    await down(db)
    await expect(
      db.raw(
        `INSERT INTO vaults
           (id, amount, start_timestamp, end_timestamp, success_destination, failure_destination, creator, status)
         VALUES (?, ?, NOW(), NOW() + INTERVAL '1 day', ?, ?, ?, ?)`,
        [
          randomUUID(),
          '100.0000000',
          'GSUCCESSXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          'GFAILUREXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
          null,
          'draft',
        ],
      ),
    ).rejects.toThrow()
  })

  it('migrates draft rows to active before removing enum value', async () => {
    // Seed a draft row
    const id = await insertVaultRow({ status: 'draft' })

    const { down } = loadMigration()
    await down(db)

    // Row should still exist, now with status = active
    const { rows } = await db.raw(
      'SELECT status FROM vaults WHERE id = ?',
      [id],
    )
    expect(rows[0].status).toBe('active')
  })
})

// ─── Unit tests: observability / PII ─────────────────────────────────────────

describeWithDb('observability — no PII in logs', () => {
  it('does not log any Stellar address patterns during up/down', async () => {
    const logged: string[] = []
    const spy = jest.spyOn(console, 'log').mockImplementation((msg: string) => {
      logged.push(msg)
    })

    const { up, down } = loadMigration()
    await up(db)
    await down(db)

    spy.mockRestore()

    const stellarPattern = /G[A-Z2-7]{55}/
    for (const entry of logged) {
      expect(entry).not.toMatch(stellarPattern)
    }
  })
})
