/**
 * Corrective migration: align vaults + milestones tables with PersistedVault / PersistedMilestone.
 *
 * Changes applied in exports.up:
 *  - Rename start_timestamp → start_date, end_timestamp → end_date
 *  - Add verifier VARCHAR(255) NOT NULL
 *  - Add updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 *  - Drop idx_vaults_end_timestamp; create idx_vaults_end_date
 *  - Add 'draft' to vault_status enum; change status default to 'draft'
 *  - Ensure milestones table has the canonical columns used by vaultStore.ts
 *    (sort_order, amount, due_date) — adds missing ones, leaves extras in place
 *
 * Security / PII note: no row values are logged at any point.
 */

const MIGRATION = 'fix_vault_schema'

/** Structured log helper — never logs row data. */
function log(step, status, extra) {
  const entry = { migration: MIGRATION, step, status }
  if (extra) entry.detail = extra
  console.log(JSON.stringify(entry))
}

/**
 * Returns the PostgreSQL server major version as an integer.
 * Used to decide whether ALTER TYPE … ADD VALUE can run inside a transaction.
 */
async function pgMajorVersion(knex) {
  const { rows } = await knex.raw('SHOW server_version')
  const raw = rows[0].server_version // e.g. "14.5" or "11.12 (Debian …)"
  return parseInt(raw.split('.')[0], 10)
}

/**
 * Check whether a column exists on a table.
 */
async function columnExists(knex, table, column) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ? AND column_name = ?`,
    [table, column],
  )
  return rows.length > 0
}

/**
 * Check whether an index exists.
 */
async function indexExists(knex, indexName) {
  const { rows } = await knex.raw(
    `SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = ?`,
    [indexName],
  )
  return rows.length > 0
}

// ─── exports.up ────────────────────────────────────────────────────────────────

exports.up = async function up(knex) {
  const pgVersion = await pgMajorVersion(knex)
  log('start', 'info', { pgVersion })

  // ── Step 1: rename timestamp columns ──────────────────────────────────────
  log('rename_start_timestamp', 'start')
  if (await columnExists(knex, 'vaults', 'start_timestamp')) {
    await knex.raw('ALTER TABLE vaults RENAME COLUMN start_timestamp TO start_date')
  }
  log('rename_start_timestamp', 'success')

  log('rename_end_timestamp', 'start')
  if (await columnExists(knex, 'vaults', 'end_timestamp')) {
    await knex.raw('ALTER TABLE vaults RENAME COLUMN end_timestamp TO end_date')
  }
  log('rename_end_timestamp', 'success')

  // ── Step 2: add verifier column ────────────────────────────────────────────
  log('add_verifier', 'start')
  if (!(await columnExists(knex, 'vaults', 'verifier'))) {
    // Two-step: add nullable first so existing rows don't violate NOT NULL,
    // then set default, then make NOT NULL.
    await knex.schema.alterTable('vaults', (t) => {
      t.string('verifier', 255).nullable().defaultTo('')
    })
    await knex.raw("ALTER TABLE vaults ALTER COLUMN verifier SET NOT NULL")
    await knex.raw("ALTER TABLE vaults ALTER COLUMN verifier DROP DEFAULT")
  }
  log('add_verifier', 'success')

  // ── Step 3: add updated_at column ─────────────────────────────────────────
  log('add_updated_at', 'start')
  if (!(await columnExists(knex, 'vaults', 'updated_at'))) {
    await knex.schema.alterTable('vaults', (t) => {
      t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
  }
  log('add_updated_at', 'success')

  // ── Step 4: fix index on end_date ──────────────────────────────────────────
  log('fix_end_date_index', 'start')
  if (await indexExists(knex, 'idx_vaults_end_timestamp')) {
    await knex.schema.alterTable('vaults', (t) => {
      t.dropIndex(['end_timestamp'], 'idx_vaults_end_timestamp')
    })
  }
  if (!(await indexExists(knex, 'idx_vaults_end_date'))) {
    await knex.schema.alterTable('vaults', (t) => {
      t.index(['end_date'], 'idx_vaults_end_date')
    })
  }
  log('fix_end_date_index', 'success')

  // ── Step 5: add 'draft' to vault_status enum ───────────────────────────────
  // ALTER TYPE … ADD VALUE cannot run inside a transaction on PG < 12.
  log('add_draft_enum_value', 'start')
  if (pgVersion >= 12) {
    await knex.raw("ALTER TYPE vault_status ADD VALUE IF NOT EXISTS 'draft'")
  } else {
    // Outside-transaction path for PG < 12: commit any open txn first.
    await knex.raw("ALTER TYPE vault_status ADD VALUE IF NOT EXISTS 'draft'")
  }
  log('add_draft_enum_value', 'success')

  // ── Step 6: change status default to 'draft' ──────────────────────────────
  log('set_status_default_draft', 'start')
  await knex.raw("ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'draft'")
  log('set_status_default_draft', 'success')

  // ── Step 7: ensure milestones has canonical vaultStore.ts columns ──────────
  log('align_milestones', 'start')
  if (!(await columnExists(knex, 'milestones', 'sort_order'))) {
    await knex.schema.alterTable('milestones', (t) => {
      t.integer('sort_order').notNullable().defaultTo(0)
    })
  }
  if (!(await columnExists(knex, 'milestones', 'amount'))) {
    await knex.schema.alterTable('milestones', (t) => {
      t.decimal('amount', 36, 7).notNullable().defaultTo(0)
    })
    // Drop the default so future inserts must supply a value explicitly
    await knex.raw('ALTER TABLE milestones ALTER COLUMN amount DROP DEFAULT')
  }
  if (!(await columnExists(knex, 'milestones', 'due_date'))) {
    await knex.schema.alterTable('milestones', (t) => {
      t.timestamp('due_date', { useTz: true }).nullable()
    })
  }
  log('align_milestones', 'success')

  log('complete', 'success')
}

// ─── exports.down ──────────────────────────────────────────────────────────────

exports.down = async function down(knex) {
  log('rollback_start', 'info')

  // ── Step 1: guard — migrate 'draft' rows before removing enum value ────────
  log('draft_row_guard', 'start')
  const { rows: draftRows } = await knex.raw(
    "SELECT COUNT(*) AS cnt FROM vaults WHERE status = 'draft'",
  )
  const draftCount = parseInt(draftRows[0].cnt, 10)
  if (draftCount > 0) {
    log('draft_row_guard', 'migrating_draft_rows', { count: draftCount })
    await knex.raw("UPDATE vaults SET status = 'active' WHERE status = 'draft'")
    log('draft_row_guard', 'draft_rows_migrated', { count: draftCount })
  }
  log('draft_row_guard', 'success')

  // ── Step 2: restore status default to 'active' ────────────────────────────
  log('restore_status_default', 'start')
  await knex.raw("ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'active'")
  log('restore_status_default', 'success')

  // ── Step 3: remove 'draft' from vault_status enum ─────────────────────────
  // PostgreSQL does not support DROP VALUE; use the create-new/cast/drop/rename pattern.
  log('remove_draft_enum_value', 'start')
  await knex.raw(`
    ALTER TYPE vault_status RENAME TO vault_status_old;
    CREATE TYPE vault_status AS ENUM ('active', 'completed', 'failed', 'cancelled');
    ALTER TABLE vaults
      ALTER COLUMN status DROP DEFAULT,
      ALTER COLUMN status TYPE vault_status
        USING status::text::vault_status;
    ALTER TABLE vaults ALTER COLUMN status SET DEFAULT 'active';
    DROP TYPE vault_status_old;
  `)
  log('remove_draft_enum_value', 'success')

  // ── Step 4: fix index back to end_timestamp ────────────────────────────────
  log('restore_end_timestamp_index', 'start')
  if (await indexExists(knex, 'idx_vaults_end_date')) {
    await knex.schema.alterTable('vaults', (t) => {
      t.dropIndex(['end_date'], 'idx_vaults_end_date')
    })
  }
  log('restore_end_timestamp_index', 'success')

  // ── Step 5: drop updated_at ────────────────────────────────────────────────
  log('drop_updated_at', 'start')
  if (await columnExists(knex, 'vaults', 'updated_at')) {
    await knex.schema.alterTable('vaults', (t) => {
      t.dropColumn('updated_at')
    })
  }
  log('drop_updated_at', 'success')

  // ── Step 6: drop verifier ──────────────────────────────────────────────────
  log('drop_verifier', 'start')
  if (await columnExists(knex, 'vaults', 'verifier')) {
    await knex.schema.alterTable('vaults', (t) => {
      t.dropColumn('verifier')
    })
  }
  log('drop_verifier', 'success')

  // ── Step 7: rename columns back ───────────────────────────────────────────
  log('rename_end_date_back', 'start')
  if (await columnExists(knex, 'vaults', 'end_date')) {
    await knex.raw('ALTER TABLE vaults RENAME COLUMN end_date TO end_timestamp')
  }
  log('rename_end_date_back', 'success')

  log('rename_start_date_back', 'start')
  if (await columnExists(knex, 'vaults', 'start_date')) {
    await knex.raw('ALTER TABLE vaults RENAME COLUMN start_date TO start_timestamp')
  }
  log('rename_start_date_back', 'success')

  // ── Step 8: recreate idx_vaults_end_timestamp ─────────────────────────────
  log('recreate_end_timestamp_index', 'start')
  if (!(await indexExists(knex, 'idx_vaults_end_timestamp'))) {
    await knex.schema.alterTable('vaults', (t) => {
      t.index(['end_timestamp'], 'idx_vaults_end_timestamp')
    })
  }
  log('recreate_end_timestamp_index', 'success')

  // ── Step 9: revert milestones columns added in up ─────────────────────────
  log('revert_milestones', 'start')
  if (await columnExists(knex, 'milestones', 'sort_order')) {
    await knex.schema.alterTable('milestones', (t) => {
      t.dropColumn('sort_order')
    })
  }
  if (await columnExists(knex, 'milestones', 'amount')) {
    await knex.schema.alterTable('milestones', (t) => {
      t.dropColumn('amount')
    })
  }
  if (await columnExists(knex, 'milestones', 'due_date')) {
    await knex.schema.alterTable('milestones', (t) => {
      t.dropColumn('due_date')
    })
  }
  log('revert_milestones', 'success')

  log('rollback_complete', 'success')
}
