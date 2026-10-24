exports.up = async function up(knex) {
  // The api_keys table is owned by a separate raw-SQL migration in
  // src/db/migrations/001_create_api_keys.sql that is applied at runtime by the
  // application. Ensure it exists here so knex CI migrations remain self-contained.
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id UUID PRIMARY KEY,
      user_id TEXT,
      org_id TEXT,
      key_hash TEXT NOT NULL,
      label TEXT NOT NULL,
      scopes TEXT[] NOT NULL DEFAULT '{ }',
      created_at TIMESTAMPZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      previous_key_hash TEXT,
      previous_valid_until TIMESTAMPTZ
    )
  `)
  await knex.raw('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ')
  await knex.raw('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS previous_key_hash TEXT')
  await knex.raw('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS previous_valid_until TIMESTAMPTZ')
  await knex.raw('CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON API_KEYS (user_id)')
  await knex.raw('CREATE INDEX IF NOT EXISTS api_keys_org_id_idx ON API_KEYS (org_id)')

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash_prefix
      ON api_keys (left(key_hash, 12))
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_revoked
      ON API_KEYS (user_id, revoked_at)
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at
      ON API_KEYS (expires_at)
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_previous_hash_prefix
      ON API_KEYS (left(previous_key_hash, 12))
  `)
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_previous_hash_prefix')
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_expires_at')
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_hash_prefix')
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_user_revoked')
  await knex.raw('ALTER TABLE api_keys DROP COLUMN IF EXISTS previous_valid_until')
  await knex.raw('ALTER TABLE api_keys DROP COLUMN IF EXISTS previous_key_hash')
  await knex.raw('ALTER TABLE api_keys DROP COLUMN IF EXISTS expires_at')
}
