import db from '../db/index.js'
import type { Knex } from 'knex'

export type PurgeSoftDeletedVaultsResult = {
  deletedVaults: number
  deletedMilestones: number
}

const DEFAULT_RETENTION_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

const validateOrganizationId = (organizationId: string): void => {
  if (typeof organizationId !== 'string' || organizationId.trim() === '') {
    throw new Error('organizationId is required')
  }
}

const getGlobalRetentionAgeMs = (): number | undefined => {
  const rawValue = process.env.RETENTION_PURGE_AGE_MS
  if (rawValue === undefined || rawValue.trim() === '') {
    return undefined
  }

  const parsed = Number(rawValue)
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error('RETENTION_PURGE_AGE_MS must be a non-negative integer')
  }

  return Math.floor(parsed)
}

const resolvePerOrgRetentionAgeMs = async (
  organizationId: string,
  knexInstance: typeof db | Knex,
): Promise<number> => {
  const org = await knexInstance('organizations')
    .select('metadata')
    .where('id', organizationId)
    .first()

  const orgRetention = org?.metadata?.retention_purge_age_ms
  if (typeof orgRetention === 'number' && Number.isFinite(orgRetention) && orgRetention >= 0) {
    return Math.floor(orgRetention)
  }

  return DEFAULT_RETENTION_AGE_MS
}

export const purgeSoftDeletedVaults = async (
  organizationId: string,
  batchSize = 500,
  knexInstance: typeof db | Knex = db,
  retentionAgeMs?: number,
): Promise<PurgeSoftDeletedVaultsResult> => {
  validateOrganizationId(organizationId)

  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    throw new Error('batchSize must be a positive integer')
  }

  const effectiveRetentionAgeMs =
    retentionAgeMs !== undefined
      ? retentionAgeMs
      : getGlobalRetentionAgeMs() ?? (await resolvePerOrgRetentionAgeMs(organizationId, knexInstance))

  return await knexInstance.transaction(async (trx) => {
    const cutoffDate =
      effectiveRetentionAgeMs > 0
        ? new Date(Date.now() - effectiveRetentionAgeMs)
        : undefined

    let query = trx('vaults')
      .where({ organization_id: organizationId })
      .whereNotNull('deleted_at')

    if (cutoffDate) {
      query = query.where('deleted_at', '<=', cutoffDate)
    }

    const vaultIds = await query.limit(batchSize).pluck('id')

    if (vaultIds.length === 0) {
      return { deletedVaults: 0, deletedMilestones: 0 }
    }

    const milestonesCountRow = await trx('milestones')
      .whereIn('vault_id', vaultIds)
      .count<{ total: string }>('id as total')
      .first()

    const deletedMilestones = Number(milestonesCountRow?.total ?? 0)

    const deletedVaults = await trx('vaults').whereIn('id', vaultIds).delete()

    return {
      deletedVaults,
      deletedMilestones,
    }
  })
}
