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
      scopes TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at TIMESTAMPTZ
    )
  `)
  await knex.raw('CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys (user_id)')
  await knex.raw('CREATE INDEX IF NOT EXISTS api_keys_org_id_idx ON api_keys (org_id)')

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_hash_prefix
      ON api_keys (left(key_hash, 12))
  `)

  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_api_keys_user_revoked
      ON api_keys (user_id, revoked_at)
  `)
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_hash_prefix')
  await knex.raw('DROP INDEX IF EXISTS idx_api_keys_user_revoked')
}
