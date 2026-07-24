/**
 * Migration for legacy API key and idempotency key support.
 *
 * These tables were historically defined in `src/db/migrations/*.sql`.
 * They are now managed in the canonical `db/migrations` directory.
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('api_keys'))) {
    await knex.schema.createTable('api_keys', (table) => {
      table.string('id', 64).primary()
      table.string('user_id', 255)
      table.string('org_id', 255)
      table.text('key_hash').notNullable()
      table.string('label', 255).notNullable()
      table.specificType('scopes', 'text[]').notNullable().defaultTo('{}')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.timestamp('revoked_at', { useTz: true })
    })

    await knex.raw('CREATE INDEX IF NOT EXISTS idx_api_keys_user_id ON api_keys (user_id)')
    await knex.raw('CREATE INDEX IF NOT EXISTS idx_api_keys_org_id ON api_keys (org_id)')
  }

  if (!(await knex.schema.hasTable('idempotency_keys'))) {
    await knex.schema.createTable('idempotency_keys', (table) => {
      table.text('key').primary()
      table.text('request_hash').notNullable()
      table.string('vault_id', 64).notNullable()
      table.jsonb('response').notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
  }
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('idempotency_keys')
  await knex.schema.dropTableIfExists('api_keys')
}
