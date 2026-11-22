// Index builds run outside a transaction to keep writes available during rollout.
exports.config = { transaction: false }

const constraints = [
  ['ck_activity_log_type', "CHECK (type IN ('create', 'validate', 'release', 'redirect', 'stake', 'evidence'))"],
  ['ck_activity_log_status', "CHECK (status IN ('pending', 'confirmed', 'failed', 'simulated'))"],
  ['ck_activity_log_amount_nonnegative', 'CHECK (amount >= 0)'],
  ['fk_activity_log_vault', 'FOREIGN KEY (vault_id) REFERENCES vaults(id)'],
]

async function preflight(knex) {
  const { rows } = await knex.raw(`
    SELECT
      count(*) FILTER (WHERE v.id IS NULL)::int AS orphans,
      count(*) FILTER (WHERE a.type NOT IN ('create', 'validate', 'release', 'redirect', 'stake', 'evidence'))::int AS invalid_type,
      count(*) FILTER (WHERE a.status NOT IN ('pending', 'confirmed', 'failed', 'simulated'))::int AS invalid_status,
      count(*) FILTER (WHERE a.amount < 0)::int AS negative_amount
    FROM activity_log a LEFT JOIN vaults v ON v.id = a.vault_id`)
  const violations = Object.entries(rows[0]).filter(([, count]) => count > 0)
  if (violations.length) {
    throw new Error('activity_log preflight failed; remediate existing rows before retrying: ' +
      violations.map(([name, count]) => `${name}=${count}`).join(', '))
  }
}

async function addConstraint(knex, name, definition) {
  const { rows } = await knex.raw(
    "SELECT 1 FROM pg_constraint WHERE conrelid = 'activity_log'::regclass AND conname = ?", [name])
  if (!rows.length) {
    await knex.raw(`ALTER TABLE activity_log ADD CONSTRAINT ?? ${definition} NOT VALID`, [name])
  }
  // Validation holds a weaker lock than creation; do not combine these statements
  // in a transaction that would retain the initial stronger lock during the scan.
  await knex.raw('ALTER TABLE activity_log VALIDATE CONSTRAINT ??', [name])
}

async function addIndex(knex, name, columns) {
  const { rows } = await knex.raw(`SELECT i.indisvalid FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = to_regclass(?)`, [name])
  if (rows[0]?.indisvalid === false) await knex.raw('DROP INDEX CONCURRENTLY ??', [name])
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ?? ON activity_log (${columns})`, [name])
}

exports.up = async function up(knex) {
  await knex.raw(`CREATE TABLE IF NOT EXISTS activity_log (
    id uuid PRIMARY KEY, type text NOT NULL, vault_id text NOT NULL,
    amount numeric(36,7) NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'confirmed',
    hash text NOT NULL, memo text, created_at timestamptz NOT NULL DEFAULT now())`)
  await preflight(knex)
  for (const [name, definition] of constraints) await addConstraint(knex, name, definition)
  await addIndex(knex, 'idx_activity_log_vault_created', 'vault_id, created_at DESC')
  await addIndex(knex, 'idx_activity_log_created', 'created_at DESC')
}

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('activity_log')
}
