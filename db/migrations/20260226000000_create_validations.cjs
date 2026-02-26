/**
 * Migration to create the validations table
 * Models validation events that record milestone validation actions and vault lifecycle transitions.
 */
exports.up = async function up(knex) {
    await knex.schema.createTable('validations', (table) => {
        table.string('id', 64).primary()
        table.string('vault_id', 64).notNullable().references('id').inTable('vaults').onDelete('CASCADE')
        table.string('milestone_id', 64).nullable()
        // Depending on whether milestones table exists, we add the foreign key. 
        // The requirements say: "Foreign keys to vaults and milestones." 
        // We add the constraint here, but if milestones does not exist, the user must add it first, 
        // or this migration needs "onDelete('CASCADE')" assuming it exists.
        table.foreign('milestone_id').references('id').inTable('milestones').onDelete('CASCADE')

        table.string('validator_user_id', 255).notNullable()
        table
            .enu('action', ['validated', 'failed', 'cancelled', 'extended'], {
                useNative: true,
                enumName: 'validation_action_type',
            })
            .notNullable()
        // JSON metadata to store additional info
        table.jsonb('metadata').nullable()
        // Transaction hash if this action was recorded on chain
        table.string('tx_hash', 128).nullable()

        // timestamps
        table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    })

    // Indexes for fast querying by vault or milestone
    await knex.schema.alterTable('validations', (table) => {
        table.index(['vault_id'], 'idx_validations_vault_id')
        table.index(['milestone_id'], 'idx_validations_milestone_id')
    })
}

exports.down = async function down(knex) {
    await knex.schema.dropTableIfExists('validations')
    await knex.raw('DROP TYPE IF EXISTS validation_action_type')
}
