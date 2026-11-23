/**
 * vaultStore.ts reads/writes vaults.late_check_in_window_secs, but no prior
 * migration ever created the column — every DB-backed vault creation fails
 * with "column does not exist" once DATABASE_URL is configured.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    table.integer('late_check_in_window_secs').notNullable().defaultTo(0)
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    table.dropColumn('late_check_in_window_secs')
  })
}
