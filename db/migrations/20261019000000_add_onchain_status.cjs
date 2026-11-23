/**
 * Track on-chain progress separately from the business `vaults.status` enum.
 * A separate column (rather than a new vault_status value) avoids ALTER TYPE ... ADD VALUE inside a
 * migration transaction and keeps every existing status filter/stat unchanged. Values:
 * NULL (simulated vault), 'pending_onchain', 'created' (create_vault confirmed, awaiting stake), 'active'.
 * activity_log gains the ledger the transaction landed in, and its type/status checks (added by
 * 20261018000000_create_activity_log) are widened for on-chain 'stake' rows and 'simulated' activity.
 */
const TYPES = ['create', 'validate', 'release', 'redirect']
const STATUSES = ['pending', 'confirmed', 'failed']
const list = (xs) => xs.map((x) => `'${x}'`).join(', ')

async function replaceCheck(knex, name, column, values) {
  await knex.raw('ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS ??', [name])
  await knex.raw(`ALTER TABLE activity_log ADD CONSTRAINT ?? CHECK (${column} IN (${list(values)}))`, [name])
}

exports.up = async function up(knex) {
  await knex.raw('ALTER TABLE vaults ADD COLUMN IF NOT EXISTS onchain_status varchar(32)')
  await knex.raw(`ALTER TABLE vaults DROP CONSTRAINT IF EXISTS vaults_onchain_status_check`)
  await knex.raw(`ALTER TABLE vaults ADD CONSTRAINT vaults_onchain_status_check CHECK (onchain_status IS NULL OR onchain_status IN ('pending_onchain','created','active'))`)
  if (await knex.schema.hasTable('activity_log')) {
    await knex.raw('ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS ledger bigint')
    await replaceCheck(knex, 'ck_activity_log_type', 'type', [...TYPES, 'stake'])
    await replaceCheck(knex, 'ck_activity_log_status', 'status', [...STATUSES, 'simulated'])
  }
}

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('activity_log')) {
    await replaceCheck(knex, 'ck_activity_log_type', 'type', TYPES)
    await replaceCheck(knex, 'ck_activity_log_status', 'status', STATUSES)
    await knex.raw('ALTER TABLE activity_log DROP COLUMN IF EXISTS ledger')
  }
  await knex.raw('ALTER TABLE vaults DROP CONSTRAINT IF EXISTS vaults_onchain_status_check')
  await knex.raw('ALTER TABLE vaults DROP COLUMN IF EXISTS onchain_status')
}
