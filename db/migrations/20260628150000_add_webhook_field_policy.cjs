/**
 * Adds field_policy column to webhook_subscribers for configurable field masking.
 *
 * field_policy is a JSONB column with structure:
 * {
 *   mode: 'allowlist' | 'denylist' | 'default',
 *   fields: string[],       // field paths to include/exclude
 *   stripPii: boolean       // whether to apply PII masking (default true)
 * }
 *
 * When mode is 'default', standard PII stripping is applied per PRIVACY.md.
 * When mode is 'allowlist', only specified fields are included (plus PII stripping if enabled).
 * When mode is 'denylist', specified fields are excluded (plus PII stripping if enabled).
 */
exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('webhook_subscribers', 'field_policy')
  if (!hasColumn) {
    await knex.schema.alterTable('webhook_subscribers', (table) => {
      table.jsonb('field_policy').nullable().defaultTo(knex.raw("'{\"mode\": \"default\", \"fields\": [], \"stripPii\": true}'::jsonb"))
    })
  }
}

exports.down = async function down(knex) {
  const hasColumn = await knex.schema.hasColumn('webhook_subscribers', 'field_policy')
  if (hasColumn) {
    await knex.schema.alterTable('webhook_subscribers', (table) => {
      table.dropColumn('field_policy')
    })
  }
}
