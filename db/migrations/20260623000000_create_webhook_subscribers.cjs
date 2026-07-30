exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('webhook_subscribers')
  if (!exists) {
    await knex.schema.createTable('webhook_subscribers', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      table.string('organization_id', 255).notNullable()
      table.string('url', 2048).notNullable()
      table.text('secret').notNullable()
      table.jsonb('events').notNullable().defaultTo(knex.raw("'[]'::jsonb"))
      table.boolean('active').notNullable().defaultTo(true)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_webhook_subscribers_org_active ON webhook_subscribers (organization_id, active)',
    )
  }
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('webhook_subscribers')
}
