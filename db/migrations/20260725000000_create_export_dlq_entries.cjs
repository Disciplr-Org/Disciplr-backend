/**
 * @param {import('knex').Knex} knex
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('export_dlq_entries', (table) => {
    table.uuid('job_id').primary()
    table.string("job_type", 64).notNullable()
    table.string('status', 16).notNullable().defaultTo('pending')
    table.string('failure_reason', 32).notNullable()
    table.text('error_message').notNullable()
    table.integer('attempt_count').notNullable().defaultTo(0)
    table.timestamp('failed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('next_retry_at', { useTz: true }).nullable()
    table.timestamp('resolved_at', { useTz: true }).nullable()
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.jsonb('sanitised_context').notNullable().defaultTo('{}')
  })

  await knex.schema.raw(`
    ALTER TABLE export_dlq_entries
      ADD CONSTRAINT  export_dlq_entries_status_valid CHECK (status IN ('pending', 'retrying', 'dead', 'resolved')),
      ADD CONSTRAINT  export_dlq_entries_attempt_count_nonnegative CHECK (attempt_count >= 0),
      ADD CONSTRAINT  export_dlq_entries_failure_reason_not_empty CHECK (length(failure_reason) > 0),
      ADD CONSTRAINT  export_dlq_entries_error_message_not_empty CHECK (length(error_message) > 0)
  `)

  // Speed up retry scans and status transitions.
  await knex.schema.raw(
    "CREATE INDEX idx_export_dlq_entries_status_next_retry ON export_dlq_entries (status, next_retry_at) WHERE status IN ('pending', 'retrying')"
  )
  await knex.schema.raw(
    "CREATE INDEX idx_export_dlq_failed_at ON export_dlq_entries (failed_at DESC)"
  )
}

/**
 * @param {import('knex').Knex} knex
 */
exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('export_dlq_entries')
}
