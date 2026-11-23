exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('audit_logs'))) return

  const hasChainSequence = await knex.schema.hasColumn('audit_logs', 'chain_seq')
  if (!hasChainSequence) {
    await knex.schema.alterTable('audit_logs', (table) => {
      table.bigInteger('chain_seq').nullable()
    })
  }

  await knex.raw(`
    WITH numbered_rows AS (
      SELECT id, ROW_NUMBER() OVER (
        PARTITION BY organization_id
        ORDER BY created_at ASC, id ASC
      ) AS sequence
      FROM audit_logs
    )
    UPDATE audit_logs AS logs
    SET chain_seq = numbered_rows.sequence
    FROM numbered_rows
    WHERE logs.id = numbered_rows.id
  `)

  await knex.raw('ALTER TABLE audit_logs ALTER COLUMN chain_seq SET NOT NULL')
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_org_chain_seq_uq
    ON audit_logs (organization_id, chain_seq)
    WHERE organization_id IS NOT NULL
  `)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_global_chain_seq_uq
    ON audit_logs (chain_seq)
    WHERE organization_id IS NULL
  `)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_org_prev_hash_uq
    ON audit_logs (organization_id, prev_hash)
    WHERE organization_id IS NOT NULL AND prev_hash IS NOT NULL
  `)
  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_logs_global_prev_hash_uq
    ON audit_logs (prev_hash)
    WHERE organization_id IS NULL AND prev_hash IS NOT NULL
  `)
}

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('audit_logs'))) return

  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_chain_seq_uq')
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_global_chain_seq_uq')
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_prev_hash_uq')
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_global_prev_hash_uq')

  if (await knex.schema.hasColumn('audit_logs', 'chain_seq')) {
    await knex.schema.alterTable('audit_logs', (table) => {
      table.dropColumn('chain_seq')
    })
  }
}
