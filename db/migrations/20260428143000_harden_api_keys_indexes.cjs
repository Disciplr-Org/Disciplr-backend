exports.up = async function up(knex) {
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
