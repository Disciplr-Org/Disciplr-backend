/*
 * Add s3_key column to export_jobs table for S3-based export storage.
 *
 * The column is nullable so pre-existing export jobs without an S3 object are
 * unaffected. A unique constraint prevents two export jobs from referencing the
 * same S3 object, which keeps state transitions deterministic and recoverable.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('export_jobs', (table) => {
    table.string('3_key', 512).nullable()
    table.unique('3_key')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('export_jobs', (table) => {
    table.dropUnique(['s3_key'])
    table.dropColumn('s3_key')
  })
}
