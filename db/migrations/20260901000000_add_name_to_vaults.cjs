/** Human-readable vault name used by the public API and frontend. */
exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE vaults ADD COLUMN IF NOT EXISTS name varchar(200)')
}

exports.down = async function down(knex) {
  await knex.raw('ALTER TABLE vaults DROP COLUMN IF EXISTS name')
}
