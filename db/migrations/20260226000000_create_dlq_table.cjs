/**
 * Dead-Letter Queue for failed jobs/events
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('dead_letter_queue', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('job_type', 100).notNullable()
    table.jsonb('payload').notNullable()
    table.text('error_message').notNullable()
    table.text('stack_trace')
    table.integer('retry_count').notNullable().defaultTo(0)
    table.timestamp('first_failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('last_failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table
      .enu('status', ['pending', 'reprocessing', 'discarded'], {
        useNative: true,
        enumName: 'dlq_status',
      })
      .notNullable()
      .defaultTo('pending')
    table.timestamp('resolved_at', { useTz: true })
  })

  await knex.schema.alterTable('dead_letter_queue', (table) => {
    table.index(['job_type'], 'idx_dlq_job_type')
    table.index(['status'], 'idx_dlq_status')
    table.index(['first_failed_at'], 'idx_dlq_first_failed_at')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('dead_letter_queue')
  await knex.raw('DROP TYPE IF EXISTS dlq_status')
}
