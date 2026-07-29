const crypto = require('crypto')

const GENESIS_HASH = '0'.repeat(64)

const normalizeTimestamp = (value) => {
  if (value instanceof Date) return value.toISOString()
  return new Date(String(value)).toISOString()
}

const normalizeJson = (value) => {
  if (value === null || typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(normalizeJson)

  return Object.keys(value)
    .sort()
    .reduce((acc, key) => {
      acc[key] = normalizeJson(value[key])
      return acc
    }, {})
}

const stableStringify = (value) => JSON.stringify(normalizeJson(value))

const canonicalizeAuditLogRow = (row) =>
  stableStringify({
    id: row.id,
    actor_user_id: row.actor_user_id,
    organization_id: row.organization_id ?? null,
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    metadata: row.metadata ?? {},
    created_at: normalizeTimestamp(row.created_at),
  })

const hashAuditLogRow = (prevHash, row) =>
  crypto
    .createHash('sha256')
    .update(stableStringify({
      prev_hash: prevHash ?? GENESIS_HASH,
      canonical_row: canonicalizeAuditLogRow(row),
    }))
    .digest('hex')

exports.up = async function (knex) {
  const hasTable = await knex.schema.hasTable('audit_logs')
  if (!hasTable) return

  const hasPrevHash = await knex.schema.hasColumn('audit_logs', 'prev_hash')
  const hasRowHash = await knex.schema.hasColumn('audit_logs', 'row_hash')

  if (!hasPrevHash || !hasRowHash) {
    await knex.schema.alterTable('audit_logs', (table) => {
      if (!hasPrevHash) table.string('prev_hash', 64).nullable()
      if (!hasRowHash) table.string('row_hash', 64).nullable()
    })
  }

  const rows = await knex('audit_logs')
    .select('*')
    .orderBy('organization_id', 'asc')
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc')

  const previousByOrganization = new Map()

  for (const row of rows) {
    const chainKey = row.organization_id ?? '__null__'
    const prevHash = previousByOrganization.get(chainKey) ?? GENESIS_HASH
    const rowHash = hashAuditLogRow(prevHash, row)

    await knex('audit_logs')
      .where({ id: row.id })
      .update({
        prev_hash: prevHash,
        row_hash: rowHash,
      })

    previousByOrganization.set(chainKey, rowHash)
  }

  await knex.raw('CREATE INDEX IF NOT EXISTS idx_audit_logs_org_prev_hash ON audit_logs (organization_id, prev_hash)')
  await knex.raw('CREATE INDEX IF NOT EXISTS idx_audit_logs_org_row_hash ON audit_logs (organization_id, row_hash)')
}

exports.down = async function (knex) {
  const hasTable = await knex.schema.hasTable('audit_logs')
  if (!hasTable) return

  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_prev_hash')
  await knex.raw('DROP INDEX IF EXISTS idx_audit_logs_org_row_hash')

  const hasPrevHash = await knex.schema.hasColumn('audit_logs', 'prev_hash')
  const hasRowHash = await knex.schema.hasColumn('audit_logs', 'row_hash')

  if (hasPrevHash || hasRowHash) {
    await knex.schema.alterTable('audit_logs', (table) => {
      if (hasPrevHash) table.dropColumn('prev_hash')
      if (hasRowHash) table.dropColumn('row_hash')
    })
  }
}
