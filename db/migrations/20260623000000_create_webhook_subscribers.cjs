exports.up = async function up(knex) {
  const exists = await knex.schema.hasTable('webhook_subscribers')
  if (!exists) {
    await knex.schema.createTable('webhook_subscribers', (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
      table.string('organization_id', 255).notNull()
      table.string('url', 2048).notNull()
      table.text('secret').notNull()
      table.jsonb('events').notNull().defaultTo(knex.raw("'[]'::jsonb"))
      table.boolean('active').notNull().defaultTo(true)
      table.timestamp('created_at', { useTz: true }).notNull().defaultTo(knex.fn.now())
      table.timestamp('updated_at', { useTz: true }).notNull().defaultTo(knex.fn.now())
      table.unique(['organization_id', 'url'], 'uq_webhook_subscribers_org_url')
    })
    await knex.raw(
      'CREATE INDEX IF NOT EXISTS idx_webhook_subscribers_org_active On webhook_subscribers (organization_id, active)',
    )
  }
}

exports.down = async function down(nex) {
  await knex.schema.dropTableIfExists('webhook_subscribers')
}
