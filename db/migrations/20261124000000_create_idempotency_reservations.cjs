/**
 * Scoped idempotency reservations for the deployed API's write routes
 * (POST /vaults, milestone validate, vault fail).
 *
 * Deliberately a sibling of `vault_creation_idempotency` rather than a
 * generalisation of it: that table's primary key is a bare `idempotency_key`
 * and the monolith coordinator in src/services/vaultCreationIdempotency.ts
 * depends on `ON CONFLICT (idempotency_key)`. Re-keying it to (scope, key)
 * would break that coordinator, so this table carries its own composite
 * primary key `(scope, idempotency_key)`, letting one reservation row exist
 * per route scope for the same client key without ever replaying a response
 * across routes. Both tables share the same state machine
 * (pending/completed + expires_at) and the same cleanup window.
 *
 * `response_body` is stored as text so a replay is byte-identical to the
 * original response body; a CHECK constraint mirrors the 64 KiB cap applied
 * in apilib/idempotency.mjs.
 */
exports.up = async function up(knex) {
  await knex.schema.createTable('idempotency_reservations', table => {
    table.string('scope', 64).notNullable()
    table.string('idempotency_key', 255).notNullable()
    table.string('request_hash', 128).notNullable()
    table.string('state', 32).notNullable().defaultTo('pending')
    table.integer('response_status').nullable()
    table.text('response_body').nullable()
    table.timestamp('expires_at', { useTz: true }).notNullable()
    table.timestamp('completed_at', { useTz: true }).nullable()
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now())
    table.primary(['scope', 'idempotency_key'])
  })

  await knex.raw(
    `ALTER TABLE idempotency_reservations
       ADD CONSTRAINT idempotency_reservations_response_body_size
       CHECK (response_body IS NULL OR length(response_body) <= 65536)`,
  )
  await knex.raw(
    `CREATE INDEX IF NOT EXISTS idx_idempotency_reservations_expiry
       ON idempotency_reservations (expires_at)`,
  )
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('idempotency_reservations')
}
