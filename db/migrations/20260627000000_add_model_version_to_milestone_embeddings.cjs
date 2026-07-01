/**
 * Migration: model_version column on milestone_embeddings
 *
 * Tracks which embedding model produced each stored vector so the reindex
 * backfill job can detect drift (rows whose model_version no longer matches
 * the currently configured model) and regenerate only those rows.
 *
 * Existing rows predate model versioning, so they are backfilled with the
 * 'legacy-unversioned' sentinel — guaranteed to differ from any real model
 * version string, which makes the backfill job pick them up automatically.
 */

const LEGACY_MODEL_VERSION = 'legacy-unversioned'

exports.up = async function up(knex) {
  await knex.schema.alterTable('milestone_embeddings', (table) => {
    table.string('model_version', 128).notNullable().defaultTo(LEGACY_MODEL_VERSION)
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('milestone_embeddings', (table) => {
    table.dropColumn('model_version')
  })
}
