
/**
 * Add performance indexes for vault and transaction queries.
 * 
 * Analysis:
 * - Transactions: Add index on stellar_timestamp for date range queries (GET /api/transactions?date_from=...)
 * - Vaults: Add index on end_date for expiration queries (expiration scheduler)
 * - Vaults: Add composite index on (status, end_date) for active vault expiration checks
 */
exports.up = async function up(knex) {
  // Index on stellar_timestamp for date range filtering in transactions
  await knex.schema.alterTable('transactions', (table) => {
    table.index(['stellar_timestamp'], 'idx_transactions_stellar_timestamp')
  })

  // Index on end_date for vault expiration queries
  await knex.schema.alterTable('vaults', (table) => {
    table.index(['end_date'], 'idx_vaults_end_date')
  })

  // Composite index for expiration checker: active vaults with past end_date
  await knex.schema.alterTable('vaults', (table) => {
    table.index(['status', 'end_date'], 'idx_vaults_status_end_date')
  })

  // Index on type + created_at for common filter combinations
  await knex.schema.alterTable('transactions', (table) => {
    table.index(['type', 'created_at'], 'idx_transactions_type_created_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('transactions', (table) => {
    table.dropIndex(['stellar_timestamp'], 'idx_transactions_stellar_timestamp')
    table.dropIndex(['type', 'created_at'], 'idx_transactions_type_created_at')
  })

  await knex.schema.alterTable('vaults', (table) => {
    table.dropIndex(['end_date'], 'idx_vaults_end_date')
    table.dropIndex(['status', 'end_date'], 'idx_vaults_status_end_date')
  })
}
