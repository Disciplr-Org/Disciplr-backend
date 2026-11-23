/**
 * Migration for per-organization notification preferences.
 *
 * Each row toggles either a single category on the 'email' channel
 * (category = a known category name) or the whole channel regardless of
 * category (category = '' sentinel, meaning "all categories").
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('org_notification_preferences', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE')
    table.string('category', 100).notNullable().defaultTo('')
    table.string('channel', 50).notNullable().defaultTo('email')
    table.boolean('enabled').notNullable().defaultTo(true)
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())

    table.unique(['organization_id', 'category', 'channel'])
  })

  await knex.raw(
    'CREATE INDEX IF NOT EXISTS idx_org_notification_preferences_org ON org_notification_preferences (organization_id)',
  )
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('org_notification_preferences')
}
