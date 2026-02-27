
/**
 * Create transactions table for vault-related on-chain transaction history.
 * Stores aggregated data from Stellar Horizon for user-facing APIs.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    
    // Foreign keys
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('vault_id', 64).notNullable().references('id').inTable('vaults').onDelete('CASCADE')
    
    // Stellar transaction details
    table.string('tx_hash', 64).notNullable().unique()
    table
      .enu('type', ['creation', 'validation', 'release', 'redirect', 'cancel'], {
        useNative: true,
        enumName: 'transaction_type',
      })
      .notNullable()
    
    // Amount and asset
    table.decimal('amount', 36, 7).notNullable()
    table.string('asset_code', 12).nullable() // XLM, USDC, etc. null for native XLM
    
    // Account details
    table.string('from_account', 56).notNullable()
    table.string('to_account', 56).notNullable()
    
    // Optional memo
    table.text('memo').nullable()
    
    // Timestamps
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.integer('stellar_ledger').notNullable()
    table.timestamp('stellar_timestamp', { useTz: true }).notNullable()
    
    // Explorer URL
    table.string('explorer_url', 255).notNullable()
  })

  // Create indexes for performance
  await knex.schema.alterTable('transactions', (table) => {
    table.index(['user_id'], 'idx_transactions_user_id')
    table.index(['vault_id'], 'idx_transactions_vault_id')
    table.index(['type'], 'idx_transactions_type')
    table.index(['created_at'], 'idx_transactions_created_at')
    table.index(['stellar_ledger'], 'idx_transactions_stellar_ledger')
    table.index(['tx_hash'], 'idx_transactions_tx_hash')
    
    // Composite index for common queries
    table.index(['user_id', 'vault_id', 'type', 'created_at'], 'idx_transactions_user_vault_type_created')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('transactions')
  await knex.raw('DROP TYPE IF EXISTS transaction_type')
}
