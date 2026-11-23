/**
 * Adds secret rotation support to webhook_subscribers.
 *
 * previous_secret: the old secret, retained during the overlap grace window so
 *   in-flight deliveries signed with it continue to verify.
 * rotated_at: when the rotation occurred; the grace window ends at
 *   rotated_at + WEBHOOK_SECRET_GRACE_WINDOW_MS (default 24 h).
 *
 * A unique index on (organization_id, url) enforces the idempotent-upsert
 * invariant: only one active subscriber per (org, URL) pair.
 */
exports.up = async function up(knex) {
  const hasPreviousSecret = await knex.schema.hasColumn('webhook_subscribers', 'previous_secret')

  if (!hasPreviousSecret) {
    await knex.schema.alterTable('webhook_subscribers', (table) => {
      table.text('previous_secret').nullable()
      table.timestamp('rotated_at', { useTz: true }).nullable()
    })
  }

  // Unique index that makes upsert idempotent on (org, url).
  // Only one row per (organization_id, url) is allowed; the upsert logic
  // relies on this constraint via ON CONFLICT DO UPDATE.
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_subscribers_org_url
    ON webhook_subscribers (organization_id, url)
  `)
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_webhook_subscribers_org_url')

  const hasPreviousSecret = await knex.schema.hasColumn('webhook_subscribers', 'previous_secret')
  if (hasPreviousSecret) {
    await knex.schema.alterTable('webhook_subscribers', (table) => {
      table.dropColumn('previous_secret')
      table.dropColumn('rotated_at')
    })
  }
}
