/**
 * Migration: backfill_cursors table
 *
 * Generic persisted cursor for resumable batch backfill jobs (see
 * src/services/backfillCursorStore.ts). Each row tracks the last processed
 * key for one named job so a crash or process restart resumes from where it
 * left off instead of restarting the whole table scan.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('backfill_cursors', (table) => {
    table.string('job_name', 255).primary()
    table.text('cursor')
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('backfill_cursors')
}
