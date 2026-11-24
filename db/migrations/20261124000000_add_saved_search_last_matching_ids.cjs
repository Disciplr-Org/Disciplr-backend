exports.up = async function up(knex) {
  await knex.schema.alterTable('org_vault_searches', (table) => {
    table.jsonb('last_matching_ids').nullable()
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('org_vault_searches', (table) => {
    table.dropColumn('last_matching_ids')
  })
}
