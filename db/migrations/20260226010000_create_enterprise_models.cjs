/**
 * Migration for Enterprise Organization & Team Models
 */
exports.up = async function up(knex) {
  // Organizations table
  await knex.schema.createTable('organizations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('name', 255).notNullable()
    table.string('slug', 255).notNullable().unique()
    table.jsonb('metadata').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  // Teams table
  await knex.schema.createTable('teams', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('name', 255).notNullable()
    table.string('slug', 255).notNullable()
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE')
    table.jsonb('metadata').nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    
    table.unique(['organization_id', 'slug'])
  })

  // Memberships table
  await knex.schema.createTable('memberships', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.string('user_id', 255).notNullable() // Assuming user_id is string from existing auth
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE')
    table.uuid('team_id').nullable().references('id').inTable('teams').onDelete('CASCADE')
    table.string('role', 50).notNullable().defaultTo('member')
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    
    table.unique(['user_id', 'organization_id', 'team_id'])
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('memberships')
  await knex.schema.dropTableIfExists('teams')
  await knex.schema.dropTableIfExists('organizations')
}
