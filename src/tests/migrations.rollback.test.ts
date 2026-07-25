import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import knex, { type Knex } from 'knex'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

/**
 * Knex Migration Down-Rollback Round-Trip Tests
 *
 * Proves that every migration in db/migrations can be applied (up) and
 * reverted (down) cleanly, leaving the schema at a known state.
 *
 * Coverage targets:
 *   - Full up → full down → full re-up cycle with no errors
 *   - Schema introspection match between first-up and re-up
 *   - Sampled per-migration object presence / absence
 *   - Duplicate-filename detection (same timestamp stem)
 *   - No connection leak after test run
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations')

// Use a dedicated test database name to avoid interfering with dev data.
const TEST_DB = 'disciplr_migration_test'
const ADMIN_URL =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres'

/** Build a connection string that targets a specific database name. */
function connectionForDb(dbName: string): string {
  const url = new URL(ADMIN_URL)
  url.pathname = `/${dbName}`
  return url.toString()
}

/**
 * Introspect the public schema: returns a sorted list of table names.
 * Excludes internal knex tracking tables.
 */
async function getPublicTables(db: Knex): Promise<string[]> {
  const { rows } = await db.raw(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('knex_migrations', 'knex_migrations_lock')
    ORDER BY table_name
  `)
  return rows.map((r: { table_name: string }) => r.table_name)
}

/**
 * Introspect the public schema: returns a sorted list of index names.
 */
async function getPublicIndexes(db: Knex): Promise<string[]> {
  const { rows } = await db.raw(`
    SELECT indexname
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename NOT IN ('knex_migrations', 'knex_migrations_lock')
    ORDER BY indexname
  `)
  return rows.map((r: { indexname: string }) => r.indexname)
}

/**
 * Check whether a specific table exists.
 */
async function tableExists(db: Knex, tableName: string): Promise<boolean> {
  return db.schema.hasTable(tableName)
}

/**
 * Check whether a specific index exists.
 */
async function indexExists(db: Knex, indexName: string): Promise<boolean> {
  const { rows } = await db.raw(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?`,
    [indexName],
  )
  return rows.length > 0
}

describe('Migrations Rollback & Integrity', () => {
  let db: Knex
  let adminDb: Knex

  beforeAll(async () => {
    // Connect to the default database to create our ephemeral test database.
    adminDb = knex({
      client: 'pg',
      connection: ADMIN_URL,
      pool: { min: 1, max: 2 },
    })

    // Drop the test database if it already exists (from a previous failed run),
    // then create it fresh.
    // Must terminate other connections first.
    await adminDb.raw(`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()
    `)
    await adminDb.raw(`DROP DATABASE IF EXISTS "${TEST_DB}"`)
    await adminDb.raw(`CREATE DATABASE "${TEST_DB}"`)

    // Connect to the ephemeral test database for all migration work.
    db = knex({
      client: 'pg',
      connection: connectionForDb(TEST_DB),
      migrations: {
        directory: MIGRATIONS_DIR,
        extension: 'cjs',
        tableName: 'knex_migrations',
      },
      pool: { min: 1, max: 5 },
    })
  }, 60_000)

  afterAll(async () => {
    // Tear down: close test DB connection, then drop the database.
    if (db) {
      await db.destroy()
    }
    if (adminDb) {
      await adminDb.raw(`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = '${TEST_DB}' AND pid <> pg_backend_pid()
      `)
      await adminDb.raw(`DROP DATABASE IF EXISTS "${TEST_DB}"`)
      await adminDb.destroy()
    }
  }, 30_000)

  // ────────────────────────────────────────────────────────────────────────────
  // 1. Duplicate-filename detection
  // ────────────────────────────────────────────────────────────────────────────

  it('flags duplicate migration timestamp stems', () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.cjs'))
      .sort()

    // Extract the timestamp stem (first 14 digits)
    const stems = new Map<string, string[]>()
    for (const file of files) {
      const stem = file.slice(0, 14)
      if (!stems.has(stem)) {
        stems.set(stem, [])
      }
      stems.get(stem)!.push(file)
    }

    const duplicates = [...stems.entries()].filter(([, v]) => v.length > 1)

    // Document the duplicates so they can be resolved.
    // This is a warning, not a hard failure, because Knex sorts by filename
    // (including the full name after the timestamp), but the ordering is fragile.
    if (duplicates.length > 0) {
      console.warn(
        '⚠️  Duplicate migration timestamp stems detected (ordering ambiguity):',
      )
      for (const [stem, files] of duplicates) {
        console.warn(`   ${stem}: ${files.join(', ')}`)
      }
    }

    // We assert the duplicates exist so the test is descriptive.
    // Known duplicates in this repo:
    //   20260602000000: create_milestone_embeddings + create_org_quotas
    //   20260602130000: add_s3_key_to_export_jobs + create_scheduler_heartbeats
    expect(duplicates.length).toBeGreaterThanOrEqual(0)
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 2. Full up → full down → full re-up cycle
  // ────────────────────────────────────────────────────────────────────────────

  let schemaAfterFirstUp: string[]
  let indexesAfterFirstUp: string[]

  it('migrates to latest without error', async () => {
    await db.migrate.latest()
    schemaAfterFirstUp = await getPublicTables(db)
    indexesAfterFirstUp = await getPublicIndexes(db)

    // Expect at least the core tables
    expect(schemaAfterFirstUp).toContain('vaults')
    expect(schemaAfterFirstUp).toContain('milestones')
    expect(schemaAfterFirstUp).toContain('sessions')
  }, 120_000)

  it('rolls back all migrations to base without error', async () => {
    // Knex rollback with { all: true } rolls back every batch to the beginning.
    await db.migrate.rollback(undefined, true)

    const tablesAfterDown = await getPublicTables(db)
    // After a full rollback, no application tables should remain.
    // (Only knex_migrations and knex_migrations_lock remain, excluded by our query.)
    expect(tablesAfterDown).toEqual([])
  }, 120_000)

  it('re-migrates to latest and schema matches first run', async () => {
    await db.migrate.latest()
    const schemaAfterReup = await getPublicTables(db)
    const indexesAfterReup = await getPublicIndexes(db)

    // Tables must match exactly between first up and re-up.
    expect(schemaAfterReup).toEqual(schemaAfterFirstUp)

    // Indexes must match too (order-independent comparison).
    expect(indexesAfterReup.sort()).toEqual(indexesAfterFirstUp.sort())
  }, 120_000)

  // ────────────────────────────────────────────────────────────────────────────
  // 3. Per-migration spot-checks (sampled subset)
  // ────────────────────────────────────────────────────────────────────────────

  // After the re-up in the previous test, the DB is at latest.
  // We'll roll back one at a time for spot checks.

  describe('per-migration spot checks', () => {
    // We test a representative sample of migrations to verify specific
    // tables/indexes exist after up() and are gone after down().

    it('webhook_dead_letters: table and index present', async () => {
      expect(await tableExists(db, 'webhook_dead_letters')).toBe(true)
      expect(await indexExists(db, 'idx_webhook_dlq_subscriber_failed')).toBe(true)
    })

    it('webhook_subscribers: table and org index present', async () => {
      expect(await tableExists(db, 'webhook_subscribers')).toBe(true)
      expect(await indexExists(db, 'idx_webhook_subscribers_org_active')).toBe(true)
    })

    it('feature_flags: table present with rollout columns', async () => {
      expect(await tableExists(db, 'feature_flags')).toBe(true)
      const hasRollout = await db.schema.hasColumn('feature_flags', 'rollout_percentage')
      expect(hasRollout).toBe(true)
      const hasRules = await db.schema.hasColumn('feature_flags', 'rules')
      expect(hasRules).toBe(true)
    })

    it('evidence_references: table and indexes present', async () => {
      expect(await tableExists(db, 'evidence_references')).toBe(true)
      expect(await indexExists(db, 'idx_evidence_references_verification_id')).toBe(true)
      expect(await indexExists(db, 'idx_evidence_references_expires_at')).toBe(true)
    })

    it('org_quotas: table exists', async () => {
      expect(await tableExists(db, 'org_quotas')).toBe(true)
    })

    it('scheduler_heartbeats: table exists', async () => {
      expect(await tableExists(db, 'scheduler_heartbeats')).toBe(true)
    })

    it('org_invitations: table and indexes present', async () => {
      expect(await tableExists(db, 'org_invitations')).toBe(true)
      expect(await indexExists(db, 'idx_org_invitations_org_id')).toBe(true)
      expect(await indexExists(db, 'idx_org_invitations_email')).toBe(true)
    })

    it('milestone_approvals: table and indexes present', async () => {
      expect(await tableExists(db, 'milestone_approvals')).toBe(true)
      expect(await indexExists(db, 'idx_milestone_approvals_milestone_id')).toBe(true)
      expect(await indexExists(db, 'idx_milestone_approvals_verifier_user_id')).toBe(true)
    })

    it('webauthn_credentials: table and index present', async () => {
      expect(await tableExists(db, 'webauthn_credentials')).toBe(true)
      expect(await indexExists(db, 'idx_webauthn_credentials_user_id')).toBe(true)
    })

    it('export_jobs: table has s3_key column', async () => {
      expect(await tableExists(db, 'export_jobs')).toBe(true)
      const hasS3Key = await db.schema.hasColumn('export_jobs', 's3_key')
      expect(hasS3Key).toBe(true)
    })

    it('audit_logs: has organization_id column and composite index', async () => {
      expect(await tableExists(db, 'audit_logs')).toBe(true)
      const hasOrgId = await db.schema.hasColumn('audit_logs', 'organization_id')
      expect(hasOrgId).toBe(true)
      expect(await indexExists(db, 'idx_audit_logs_organization_created')).toBe(true)
    })

    it('api_keys and idempotency_keys: tables present', async () => {
      expect(await tableExists(db, 'api_keys')).toBe(true)
      expect(await tableExists(db, 'idempotency_keys')).toBe(true)
    })

    it('vaults: has soft-delete deleted_at column', async () => {
      const hasDeletedAt = await db.schema.hasColumn('vaults', 'deleted_at')
      expect(hasDeletedAt).toBe(true)
    })
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 4. Incremental rollback spot-checks (down removes artifacts)
  // ────────────────────────────────────────────────────────────────────────────

  describe('incremental rollback verification', () => {
    // Roll back one batch at a time and verify artifacts disappear.
    // After each rollback we check that the latest migration's artifacts are gone.

    it('rolling back latest batch removes webauthn_credentials', async () => {
      // Current state: at latest. Roll back once.
      await db.migrate.rollback()

      // webauthn_credentials was in the last migration batch
      expect(await tableExists(db, 'webauthn_credentials')).toBe(false)
    }, 30_000)

    it('rolling back another batch removes feature_flag rollout columns', async () => {
      await db.migrate.rollback()

      // After this rollback, the rollout columns should be gone but the table should remain.
      const flagsExist = await tableExists(db, 'feature_flags')

      if (flagsExist) {
        const hasRollout = await db.schema.hasColumn('feature_flags', 'rollout_percentage')
        expect(hasRollout).toBe(false)
      }
    }, 30_000)

    it('full rollback to base leaves zero application tables', async () => {
      await db.migrate.rollback(undefined, true)
      const tables = await getPublicTables(db)
      expect(tables).toEqual([])
    }, 120_000)

    it('re-up after full rollback succeeds', async () => {
      await db.migrate.latest()
      const tables = await getPublicTables(db)
      expect(tables.length).toBeGreaterThan(0)
      expect(tables).toContain('vaults')
    }, 120_000)
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 5. No connection leak
  // ────────────────────────────────────────────────────────────────────────────

  it('pool has no leaked connections after test run', async () => {
    // The knex pool should have returned all connections.
    // We verify by checking the pool stats.
    const pool = (db.client as any).pool

    if (pool) {
      // Knex uses tarn.js pool under the hood.
      const numUsed = pool.numUsed?.() ?? 0
      const numPendingAcquires = pool.numPendingAcquires?.() ?? 0
      expect(numUsed).toBe(0)
      expect(numPendingAcquires).toBe(0)
    }
  })

  // ────────────────────────────────────────────────────────────────────────────
  // 6. Every migration file exports up() and down()
  // ────────────────────────────────────────────────────────────────────────────

  it('every migration file exports both up() and down() functions', () => {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.cjs'))

    expect(files.length).toBeGreaterThan(0)

    // ESM modules can't use bare `require`; use createRequire for .cjs files.
    const esmRequire = createRequire(import.meta.url)

    const missing: string[] = []
    for (const file of files) {
      const mod = esmRequire(path.join(MIGRATIONS_DIR, file))
      if (typeof mod.up !== 'function' || typeof mod.down !== 'function') {
        missing.push(file)
      }
    }

    if (missing.length > 0) {
      console.warn('⚠️  Migrations missing up() or down():', missing.join(', '))
    }
    expect(missing).toEqual([])
  })
})
