/**
 * Create transactions table for vault-related operations
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('transactions', (table) => {
    table.string('id', 64).primary()
    table.string('vault_id', 64).notNullable()
    table
      .enu('type', ['creation', 'validation', 'release', 'redirect', 'cancel'], {
        useNative: true,
        enumName: 'transaction_type',
      })
      .notNullable()
    table.decimal('amount', 36, 7).nullable()
    table.timestamp('timestamp', { useTz: true }).notNullable()
    table.string('stellar_transaction_hash', 64).nullable()
    table.text('stellar_explorer_url').nullable()
    table.jsonb('metadata').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('transactions', (table) => {
    table.index(['vault_id'], 'idx_transactions_vault_id')
    table.index(['type'], 'idx_transactions_type')
    table.index(['timestamp'], 'idx_transactions_timestamp')
    table.index(['stellar_transaction_hash'], 'idx_transactions_stellar_hash')
    table.unique(['stellar_transaction_hash'], 'uq_transactions_stellar_hash')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('transactions')
  await knex.raw('DROP TYPE IF EXISTS transaction_type')
}
