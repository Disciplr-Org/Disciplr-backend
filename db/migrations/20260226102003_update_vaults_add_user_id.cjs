
/**
 * Update vaults table to add user_id foreign key relationship.
 * Links vaults to users for transaction history ownership.
 */
exports.up = async function up(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    // Add user_id foreign key
    table.uuid('user_id').nullable().references('id').inTable('users').onDelete('CASCADE')
    
    // Add index for user_id queries
    table.index(['user_id'], 'idx_vaults_user_id')
  })
}

exports.down = async function down(knex) {
  await knex.schema.alterTable('vaults', (table) => {
    table.dropIndex(['user_id'], 'idx_vaults_user_id')
    table.dropColumn('user_id')
  })
}
