/**
 * Analytics storage migration for PostgreSQL.
 * Creates summary + rollup tables used by analytics dual-write/backfill.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('analytics_vault_summary', (table) => {
    table.specificType('id', 'smallint').primary()
    table.integer('total_vaults').notNullable().defaultTo(0)
    table.integer('active_vaults').notNullable().defaultTo(0)
    table.integer('completed_vaults').notNullable().defaultTo(0)
    table.integer('failed_vaults').notNullable().defaultTo(0)
    table.decimal('total_locked_capital', 20, 7).notNullable().defaultTo(0)
    table.decimal('active_capital', 20, 7).notNullable().defaultTo(0)
    table.decimal('success_rate', 10, 4).notNullable().defaultTo(0)
    table.timestamp('last_updated', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.createTable('analytics_vault_daily_rollups', (table) => {
    table.date('bucket_date').primary()
    table.integer('total_vaults').notNullable().defaultTo(0)
    table.integer('active_vaults').notNullable().defaultTo(0)
    table.integer('completed_vaults').notNullable().defaultTo(0)
    table.integer('failed_vaults').notNullable().defaultTo(0)
    table.decimal('total_locked_capital', 20, 7).notNullable().defaultTo(0)
    table.decimal('active_capital', 20, 7).notNullable().defaultTo(0)
    table.decimal('success_rate', 10, 4).notNullable().defaultTo(0)
    table.timestamp('last_updated', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.raw(`
    CREATE INDEX IF NOT EXISTS idx_analytics_rollups_last_updated
    ON analytics_vault_daily_rollups(last_updated)
  `)
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('analytics_vault_daily_rollups')
  await knex.schema.dropTableIfExists('analytics_vault_summary')
}
