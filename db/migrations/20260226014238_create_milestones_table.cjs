/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = async function(knex) {
  // Ensure the enum exists only once (some earlier migrations may create it).
  await knex.raw(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'milestone_status') THEN
        CREATE TYPE milestone_status AS ENUM ('pending', 'submitted', 'approved', 'rejected');
      END IF;
    END
    $$;
  `);

  await knex.raw(`
    CREATE TABLE IF NOT EXISTS milestones (
      id VARCHAR(64) PRIMARY KEY,
      vault_id VARCHAR(64) NOT NULL REFERENCES vaults(id) ON DELETE CASCADE ON UPDATE CASCADE,
      title VARCHAR(255) NOT NULL,
      description TEXT,
      type VARCHAR(100) NOT NULL,
      criteria JSONB NOT NULL,
      weight INTEGER NOT NULL DEFAULT 0,
      due_date TIMESTAMPTZ,
      status milestone_status NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_milestones_vault_id ON milestones(vault_id);
    CREATE INDEX IF NOT EXISTS idx_milestones_status ON milestones(status);
  `);
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = async function(knex) {
  // Why this down changed:
  // If the milestones table was created by the earlier migration (20260225200000_create_milestones.cjs),
  // dropping it here with CASCADE would drop a table this migration did not create and would break
  // rollback ordering for earlier dependent tables (such as validations). When the earlier migration is
  // present (recorded in knex_migrations or indicated by the presence of target_amount), this down is a no-op,
  // leaving the table to be dropped by 20260225200000_create_milestones in proper sequence.
  const hasEarlierMigration = await knex.schema.hasTable('knex_migrations').then(async (exists) => {
    if (!exists) return false
    const row = await knex('knex_migrations')
      .where('name', 'like', '%20260225200000_create_milestones%')
      .first()
    return !!row
  }).catch(() => false)

  const hasTargetAmount = await knex.schema.hasColumn('milestones', 'target_amount').catch(() => false)

  if (!hasEarlierMigration && !hasTargetAmount) {
    await knex.raw('DROP TABLE IF EXISTS milestones CASCADE')
  }
};