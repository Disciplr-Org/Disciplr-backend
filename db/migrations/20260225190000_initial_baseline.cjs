/**
 * Baseline migration for current backend domain model.
 * Mirrors the fields used by the in-memory vault representation.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('vaults', (table) => {
    table.string('id', 64).primary()
    table.string('creator', 255).notNullable()
    table.decimal('amount', 36, 7).notNullable()
    table.timestamp('start_timestamp', { useTz: true }).notNullable()
    table.timestamp('end_timestamp', { useTz: true }).notNullable()
    table.string('success_destination', 255).notNullable()
    table.string('failure_destination', 255).notNullable()
    table
      .enu('status', ['active', 'completed', 'failed', 'cancelled'], {
        useNative: true,
        enumName: 'vault_status',
      })
      .notNullable()
      .defaultTo('active')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('vaults', (table) => {
    table.index(['creator'], 'idx_vaults_creator')
    table.index(['status'], 'idx_vaults_status')
    table.index(['end_timestamp'], 'idx_vaults_end_timestamp')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vaults')
  await knex.raw('DROP TYPE IF EXISTS vault_status')
}
