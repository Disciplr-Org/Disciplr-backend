/**
 * Migration for milestones table.
 * Stores milestone data for vault progress tracking.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('milestones', (table) => {
    table.string('id', 64).primary()
    table.string('vault_id', 64).notNullable()
    table.string('title', 255).notNullable()
    table.text('description')
    table.decimal('target_amount', 36, 7).notNullable()
    table.decimal('current_amount', 36, 7).notNullable().defaultTo(0)
    table.timestamp('deadline', { useTz: true }).notNullable()
    table
      .enu('status', ['pending', 'in_progress', 'completed', 'failed'], {
        useNative: true,
        enumName: 'milestone_status',
      })
      .notNullable()
      .defaultTo('pending')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.foreign('vault_id').references('id').inTable('vaults').onDelete('CASCADE')
  })

  await knex.schema.alterTable('milestones', (table) => {
    table.index(['vault_id'], 'idx_milestones_vault_id')
    table.index(['status'], 'idx_milestones_status')
    table.index(['deadline'], 'idx_milestones_deadline')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('milestones')
  await knex.raw('DROP TYPE IF EXISTS milestone_status')
}
