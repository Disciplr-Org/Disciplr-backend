exports.up = async function up(knex) {
  const hasColumn = await knex.schema.hasColumn('webhook_subscribers', 'schema_version')
  if (!hasColumn) {
    await knex.schema.alterTable('webhook_subscribers', (table) => {
      table.integer('schema_version').notNullable().defaultTo(1)
    })
  }
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('webhook_subscribers', (table) => {
    table.dropColumn('schema_version')
  })
}
