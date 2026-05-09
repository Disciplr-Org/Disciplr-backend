exports.up = async function up(knex) {
  await knex.schema.createTable('export_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('requester_user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
    table.boolean('requester_is_admin').notNullable().defaultTo(false)
    table.uuid('target_user_id').nullable().references('id').inTable('users').onDelete('CASCADE')
    table.string('scope', 32).notNullable()
    table.string('format', 16).notNullable()
    table.string('status', 16).notNullable().defaultTo('pending')
    table.integer('attempts').notNullable().defaultTo(0)
    table.integer('max_attempts').notNullable().defaultTo(3)
    table.string('idempotency_key', 255).nullable()
    table.string('request_hash', 64).notNullable()
    table.text('error').nullable()
    table.binary('result_data').nullable()
    table.string('filename', 255).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('completed_at', { useTz: true }).nullable()
  })

  await knex.schema.alterTable('export_jobs', (table) => {
    table.index(['requester_user_id', 'status'], 'idx_export_jobs_requester_status')
    table.index(['status', 'created_at'], 'idx_export_jobs_status_created_at')
    table.unique(['requester_user_id', 'idempotency_key'], {
      indexName: 'uq_export_jobs_requester_idempotency_key',
    })
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('export_jobs')
}
