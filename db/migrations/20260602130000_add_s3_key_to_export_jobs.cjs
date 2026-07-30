/**
 * Add s3_key column to export_jobs table for S3-based export storage.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('export_jobs', (table) => {
    table.string('s3_key', 512).nullable()
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('export_jobs', (table) => {
    table.dropColumn('s3_key')
  })
}
