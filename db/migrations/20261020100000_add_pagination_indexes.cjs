// Add indexes to support cursor pagination on vaults and activity_log.
// Index builds run outside a transaction to keep writes available during rollout.
exports.config = { transaction: false }

async function addIndex(knex, name, table, columns) {
  const { rows } = await knex.raw(`SELECT i.indisvalid FROM pg_index i
    JOIN pg_class c ON c.oid = i.indexrelid WHERE c.oid = to_regclass(?)`, [name])
  if (rows[0]?.indisvalid === false) await knex.raw('DROP INDEX CONCURRENTLY ??', [name])
  await knex.raw(`CREATE INDEX CONCURRENTLY IF NOT EXISTS ?? ON ${table} (${columns})`, [name])
}

exports.up = async function up(knex) {
  // Check if vaults already has a suitable index for (created_at DESC, id DESC)
  const { rows: vaultIndexes } = await knex.raw(`
    SELECT
      i.relname AS index_name,
      array_agg(a.attname ORDER BY array_position(ix.indkey, a.attnum)) AS columns
    FROM pg_index ix
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relname = 'vaults'
      AND NOT ix.indisprimary
      AND a.attname IN ('created_at', 'id')
    GROUP BY i.relname
  `)

  const hasVaultIndex = vaultIndexes.some((row) => {
    const cols = row.columns
    return cols.length >= 2 && cols[0] === 'created_at' && cols[1] === 'id'
  })

  if (!hasVaultIndex) {
    await addIndex(knex, 'idx_vaults_created_id', 'vaults', 'created_at DESC, id DESC')
  }

  // Activity pagination indexes (vault-scoped and global)
  await addIndex(knex, 'idx_activity_log_vault_created_id', 'activity_log', 'vault_id, created_at DESC, id DESC')
  await addIndex(knex, 'idx_activity_log_created_id', 'activity_log', 'created_at DESC, id DESC')
}

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_vaults_created_id')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_log_vault_created_id')
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_activity_log_created_id')
}
