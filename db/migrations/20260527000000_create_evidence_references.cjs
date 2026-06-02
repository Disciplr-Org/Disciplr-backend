exports.up = async function (knex) {
  await knex.schema.createTable('evidence_references', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'))
    table.uuid('verification_id').notNullable().references('id').inTable('verifications').onDelete('CASCADE')
    table.string('evidence_hash', 128).notNullable()
    table.text('reference_url').notNullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('evidence_references', (table) => {
    table.unique(['verification_id'])
    table.index(['verification_id'], 'idx_evidence_references_verification_id')
    table.index(['expires_at'], 'idx_evidence_references_expires_at')
  })
}

exports.down = async function (knex) {
  await knex.schema.dropTableIfExists('evidence_references')
}
