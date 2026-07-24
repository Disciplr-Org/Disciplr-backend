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
  // Use CASCADE because earlier migrations (validations, etc.) may have
  // foreign keys referencing milestones that haven't been dropped yet at
  // this point in the rollback order.
  await knex.raw('DROP TABLE IF EXISTS milestones CASCADE');
};