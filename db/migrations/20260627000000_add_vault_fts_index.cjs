/**
 * Add full-text search support to the vaults table.
 *
 * Creates a tsvector column (`search_vector`) populated from the vault's
 * `creator` and `verifier` fields and maintained automatically via a trigger.
 * A GIN index on that column enables fast, index-only FTS queries.
 *
 * Security note: no row data is logged at any step.
 */

exports.config = { transaction: false }

exports.up = async function up(knex) {
  // 1. Add the tsvector column (nullable initially so existing rows are valid)
  await knex.raw(`
    ALTER TABLE vaults
    ADD COLUMN IF NOT EXISTS search_vector tsvector
  `)

  // 2. Back-fill existing rows
  await knex.raw(`
    UPDATE vaults
    SET search_vector =
      to_tsvector('simple', coalesce(creator, '') || ' ' || coalesce(verifier, ''))
  `)

  // 3. Create GIN index for fast full-text lookups
  await knex.raw(`
    CREATE INDEX IF NOT EXISTS idx_vaults_search_vector
    ON vaults USING GIN (search_vector)
  `)

  // 4. Trigger function: keep search_vector in sync on INSERT / UPDATE
  await knex.raw(`
    CREATE OR REPLACE FUNCTION vaults_search_vector_update()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      NEW.search_vector :=
        to_tsvector('simple',
          coalesce(NEW.creator,  '') || ' ' ||
          coalesce(NEW.verifier, '')
        );
      RETURN NEW;
    END;
    $$
  `)

  // 5. Attach trigger to the table (drop-if-exists for idempotency)
  await knex.raw(`
    DROP TRIGGER IF EXISTS trg_vaults_search_vector ON vaults
  `)
  await knex.raw(`
    CREATE TRIGGER trg_vaults_search_vector
    BEFORE INSERT OR UPDATE OF creator, verifier
    ON vaults
    FOR EACH ROW EXECUTE FUNCTION vaults_search_vector_update()
  `)
}

exports.down = async function down(knex) {
  await knex.raw(`DROP TRIGGER IF EXISTS trg_vaults_search_vector ON vaults`)
  await knex.raw(`DROP FUNCTION IF EXISTS vaults_search_vector_update()`)
  await knex.raw(`DROP INDEX IF EXISTS idx_vaults_search_vector`)
  await knex.raw(`ALTER TABLE vaults DROP COLUMN IF EXISTS search_vector`)
}
