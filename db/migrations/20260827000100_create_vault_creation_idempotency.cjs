/**
 * Durable idempotency reservations for POST /api/vaults.
 *
 * This table is separate from the older response cache because vault creation
 * needs a pending state and an expiry. The unique key is acquired before the
 * vault transaction and finalized in that same transaction.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('vault_creation_idempotency', table => {
    table.string('idempotency_key', 255).primary()
    table.string('request_hash', 128).notNullable()
    table.string('user_id', 255).nullable()
    table.string('org_id', 255).nullable()
    table.string('state', 32).notNullable().defaultTo('pending')
    table.string('vault_id', 128).nullable()
    table.jsonb('response').nullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.timestamp('completed_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_vault_creation_idempotency_expiry
       ON vault_creation_idempotency (expires_at)
      WHERE state = 'pending'`,
  )
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_vault_creation_idempotency_owner
       ON vault_creation_idempotency (user_id, org_id)`,
  )
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vault_creation_idempotency')
}
