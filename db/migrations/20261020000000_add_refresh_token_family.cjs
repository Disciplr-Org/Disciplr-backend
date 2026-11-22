/**
 * Add family_id and replaced_by_id columns to RefreshToken table for
 * refresh token rotation family tracking and reuse detection.
 */
exports.up = async function up(knex) {
  // Check if RefreshToken or refresh_tokens table exists
  const hasRefreshTokenPascal = await knex.schema.hasTable('RefreshToken')
  const hasRefreshTokenSnake = await knex.schema.hasTable('refresh_tokens')

  const tableName = hasRefreshTokenPascal
    ? 'RefreshToken'
    : hasRefreshTokenSnake
    ? 'refresh_tokens'
    : 'RefreshToken'

  const tableExists = hasRefreshTokenPascal || hasRefreshTokenSnake
  if (tableExists) {
    const hasFamilyId = await knex.schema.hasColumn(tableName, 'family_id')
    const hasReplacedById = await knex.schema.hasColumn(tableName, 'replaced_by_id')

    if (!hasFamilyId || !hasReplacedById) {
      await knex.schema.alterTable(tableName, (table) => {
        if (!hasFamilyId) {
          table.string('family_id', 255).nullable().index('RefreshToken_family_id_idx')
        }
        if (!hasReplacedById) {
          table.string('replaced_by_id', 255).nullable().unique('RefreshToken_replaced_by_id_key')
        }
      })
    }
  }
}

exports.down = async function down(knex) {
  const hasRefreshTokenPascal = await knex.schema.hasTable('RefreshToken')
  const hasRefreshTokenSnake = await knex.schema.hasTable('refresh_tokens')

  const tableName = hasRefreshTokenPascal
    ? 'RefreshToken'
    : hasRefreshTokenSnake
    ? 'refresh_tokens'
    : 'RefreshToken'

  const tableExists = hasRefreshTokenPascal || hasRefreshTokenSnake
  if (tableExists) {
    const hasFamilyId = await knex.schema.hasColumn(tableName, 'family_id')
    const hasReplacedById = await knex.schema.hasColumn(tableName, 'replaced_by_id')

    if (hasFamilyId || hasReplacedById) {
      await knex.schema.alterTable(tableName, (table) => {
        if (hasFamilyId) {
          table.dropIndex(['family_id'], 'RefreshToken_family_id_idx')
          table.dropColumn('family_id')
        }
        if (hasReplacedById) {
          table.dropUnique(['replaced_by_id'], 'RefreshToken_replaced_by_id_key')
          table.dropColumn('replaced_by_id')
        }
      })
    }
  }
}
