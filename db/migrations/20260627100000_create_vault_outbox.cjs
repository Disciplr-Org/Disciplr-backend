/**
 * Migration: create vault_outbox table for transactional outbox pattern.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('vault_outbox', (table) => {
    table.increments('id').primary()
    table.string('event_id').notNullable().unique()
    table.string('event_type').notNullable()
    table.jsonb('payload').notNullable()
    table.boolean('processed').notNullable().defaultTo(false)
    table.integer('attempts').notNullable().defaultTo(0)
    table.text('last_error').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('processed_at', { useTz: true }).nullable()
  })

  await knex.schema.alterTable('vault_outbox', (table) => {
    table.index(['processed'], 'idx_vault_outbox_processed')
    table.index(['created_at'], 'idx_vault_outbox_created_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('vault_outbox')
}
