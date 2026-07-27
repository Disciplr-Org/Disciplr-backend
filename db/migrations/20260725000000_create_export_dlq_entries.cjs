/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('export_dlq_entries', (table) => {
    table.uuid('job_id').primary()
    table.string('job_type', 64).notNullable()
    table.string('failure_reason', 32).notNullable()
    table.text('error_message').notNullable()
    table.integer('attempt_count').notNullable()
    table.timestamp('failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.jsonb('sanitised_context').notNullable().defaultTo('{}')
  })

  await knex.schema.raw(
    'CREATE INDEX idx_export_dlq_failed_at ON export_dlq_entries (failed_at DESC)',
  )
}

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('export_dlq_entries')
}
