/**
 * Migration: add milestone_document_references table
 * Stores off-chain document references (URL + optional content hash)
 * linked to vault milestones.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('milestone_document_references', (table) => {
    table.string('id', 64).primary()
    table.string('vault_id', 64).notNullable().references('id').inTable('vaults').onDelete('CASCADE')
    table.string('label', 255).notNullable()
    table.string('url', 2048).notNullable()
    table.string('content_hash', 128).nullable() // optional SHA-256 or similar
    table.string('hash_algorithm', 32).nullable() // e.g. 'sha256'
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
  })

  await knex.schema.alterTable('milestone_document_references', (table) => {
    table.index(['vault_id'], 'idx_doc_refs_vault_id')
  })
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('milestone_document_references')
}