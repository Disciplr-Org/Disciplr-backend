// Migration for milestone evidence submission storage.
// Index builds run outside a transaction to keep writes available during rollout.
exports.config = { transaction: false }

const constraints = [
  ['ck_milestone_evidence_url_https', "CHECK (url ~ '^https://')"],
  ['ck_milestone_evidence_sha256_format', "CHECK (sha256 ~ '^[0-9a-f]{64}$')"],
  ['ck_milestone_evidence_note_length', 'CHECK (char_length(note) <= 1000)'],
  ['ck_milestone_evidence_url_length', 'CHECK (char_length(url) <= 2048)'],
  ['fk_milestone_evidence_vault', 'FOREIGN KEY (vault_id) REFERENCES vaults(id)'],
  ['fk_milestone_evidence_milestone', 'FOREIGN KEY (milestone_id) REFERENCES milestones(id)'],
]

async function preflight(knex) {
  const hasTable = await knex.schema.hasTable('milestone_evidence')
  if (!hasTable) return

  const { rows } = await knex.raw(`
    SELECT
      count(*) FILTER (WHERE v.id IS NULL)::int AS orphan_vaults,
      count(*) FILTER (WHERE m.id IS NULL)::int AS orphan_milestones,
      count(*) FILTER (WHERE url !~ '^https://')::int AS invalid_urls,
      count(*) FILTER (WHERE sha256 !~ '^[0-9a-f]{64}$')::int AS invalid_sha256,
      count(*) FILTER (WHERE char_length(note) > 1000)::int AS note_too_long,
      count(*) FILTER (WHERE char_length(url) > 2048)::int AS url_too_long
    FROM milestone_evidence e
    LEFT JOIN vaults v ON v.id = e.vault_id
    LEFT JOIN milestones m ON m.id = e.milestone_id`)

  const violations = Object.entries(rows[0]).filter(([, count]) => count > 0)
  if (violations.length) {
    throw new Error('milestone_evidence preflight failed; remediate existing rows before retrying: ' +
      violations.map(([name, count]) => `${name}=${count}`).join(', '))
  }
}

async function addConstraint(knex, name, definition) {
  const { rows } = await knex.raw(
    "SELECT 1 FROM pg_constraint WHERE conrelid = 'milestone_evidence'::regclass AND conname = ?", [name])
  if (!rows.length) {
    await knex.raw(`ALTER TABLE milestone_evidence ADD CONSTRAINT ?? ${definition} NOT VALID`, [name])
  }
  await knex.raw('ALTER TABLE milestone_evidence VALIDATE CONSTRAINT ??', [name])
}

async function addIndex(knex, name, columns) {
  const { rows } = await knex.raw(`SELECT i.indisvalid FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = to_regclass(?)`, [name])
  if (rows[0]?.indisvalid === false) await knex.raw('DROP INDEX CONCURRENTLY ??', [name])
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ?? ON milestone_evidence (${columns})`, [name])
}

exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE IF NOT EXISTS milestone_evidence (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    vault_id text NOT NULL,
    milestone_id text NOT NULL,
    url text NOT NULL,
    sha256 char(64) NOT NULL,
    note text,
    submitted_by text NOT NULL,
    verified boolean DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`)

  await preflight(knex)
  for (const [name, definition] of constraints) await addConstraint(knex, name, definition)
  await addIndex(knex, 'idx_milestone_evidence_milestone_created', 'milestone_id, created_at DESC')
  await addIndex(knex, 'idx_milestone_evidence_vault', 'vault_id')
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('milestone_evidence')
}
