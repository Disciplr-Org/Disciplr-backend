/**
 * Migration: create org_webhook_egress_allowlists
 *
 * Stores per-organization egress allowlist entries for webhook delivery.
 * When at least one row exists for an org, webhook delivery is restricted to
 * URLs whose hostname matches an entry (exact or subdomain).
 *
 * Columns:
 *   id              – surrogate PK (UUID)
 *   organization_id – owning organization
 *   host            – permitted hostname pattern, e.g. "hooks.example.com"
 *                     (subdomains are implicitly allowed, e.g. "a.hooks.example.com")
 *   created_at      – row creation timestamp
 */

exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('org_webhook_egress_allowlists')
  if (!exists) {
    await knex.schema.createTable('org_webhook_egress_allowlists', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      table.string('organization_id', 255).notNullable()
      table.string('host', 253).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.unique(['organization_id', 'host'])
    })
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_egress_allowlist_org ON org_webhook_egress_allowlists (organization_id)',
    )
  }
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('org_webhook_egress_allowlists')
}
