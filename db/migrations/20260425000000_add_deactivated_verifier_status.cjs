exports.config = { transaction: false }

exports.up = async function up(knex) {
  await knex.raw("ALTER TYPE verifier_status ADD VALUE IF NOT EXISTS 'deactivated'")

  await knex.schema.alterTable('verifiers', (table) => {
    table.timestamp('deactivated_at', { useTz: true })
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('verifiers', (table) => {
    table.dropColumn('deactivated_at')
  })

  // PostgreSQL cannot drop a single enum value without recreating the enum and
  // rewriting dependent columns. Leave verifier_status.deactivated in place on rollback.
}
