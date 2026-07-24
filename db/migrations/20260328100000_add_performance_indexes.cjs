
/**
 * Add performance indexes for vault and transaction queries.
 * 
 * Analysis:
 * - Transactions: Add index on stellar_timestamp for date range queries (GET /api/transactions?date_from=...)
 * - Vaults: Add index on end_date for expiration queries (expiration scheduler)
 * - Vaults: Add composite index on (status, end_date) for active vault expiration checks
 */
exports.up = async function up(knex) {
  // Use raw CREATE INDEX IF NOT EXISTS to remain idempotent across environments
  // where some indexes may have been created by earlier corrective migrations.
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_transactions_stellar_timestamp ON transactions (stellar_timestamp)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_end_date ON vaults (end_date)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_vaults_status_end_date ON vaults (status, end_date)',
  )
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_transactions_type_created_at ON transactions (type, created_at)',
  )
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
