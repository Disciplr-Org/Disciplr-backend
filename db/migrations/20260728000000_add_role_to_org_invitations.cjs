exports.up = async function up(knex) {
  await knex.schema.alterTable('org_invitations', (table) => {
    table.text('role').notNullable().defaultTo('member')
  })

  await knex('org_invitations').update({ role: 'member' })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('org_invitations', (table) => {
    table.dropColumn('role')
  })
}
