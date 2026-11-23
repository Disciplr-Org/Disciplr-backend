/**
 * Org-scoped saved vault searches with optional change-alert subscriptions.
 *
 * Each row captures a validated query definition that an operator wants to
 * replay on a schedule.  When alerts_enabled is true the periodic evaluation
 * job hashes the result set and dispatches a notification whenever the hash
 * changes (i.e. new vaults matched or existing ones dropped out).
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('org_vault_searches', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('org_id', 255).notNullable()
    table.string('name', 255).notNullable()
    // Validated query params stored as JSONB (fields: q, status, verifier,
    // amount_min, amount_max, date_from, date_to, sort_by, sort_order, limit)
    table.jsonb('query_definition').notNullable()
    table.boolean('alerts_enabled').notNullable().defaultTo(false)
    // Recipient to notify when results change (email or user id)
    table.string('alert_recipient', 255).nullable()
    // Minimum ms between alert evaluations — floor enforced at 3 600 000 (1 h)
    table.integer('alert_frequency_ms').notNullable().defaultTo(3_600_000)
    table.timestamp('last_evaluated_at', { useTz: true }).nullable()
    // SHA-256 hex of the last result set used to detect changes
    table.string('last_result_hash', 64).nullable()
    table.string('created_by', 255).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Org-scoped look-up (list + cap check)
  await knex.raw(
    'CREATE INDEX idx_org_vault_searches_org_id ON org_vault_searches (org_id)',
  )
  // Evaluation job: find alert rows due for re-evaluation
  await knex.raw(
    'CREATE INDEX idx_org_vault_searches_alerts ON org_vault_searches (alerts_enabled, last_evaluated_at) WHERE alerts_enabled = true',
  )
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('org_vault_searches')
}
