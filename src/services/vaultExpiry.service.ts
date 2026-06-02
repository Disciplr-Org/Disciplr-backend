import db from '../db/index.js'
import { createNotification } from './notification.js'

export const markVaultExpiries = async (
  opts: { now?: Date; limit?: number } = {}
): Promise<number> => {
  const now = (opts.now ?? new Date()).toISOString()

  const query = db('vaults')
    .where('status', 'active')
    .andWhere('end_date', '<=', now)

  if (opts.limit) {
    query.limit(opts.limit)
  }

  const expiredVaults = await query.select('*')

  if (expiredVaults.length === 0) return 0

  const expiredIds = expiredVaults.map(v => v.id)

  await db('vaults')
    .whereIn('id', expiredIds)
    .where('status', 'active')
    .update({ status: 'failed' })

  for (const vault of expiredVaults) {
    await createNotification({
      user_id: vault.creator,
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: 'A vault in your account has expired and been marked as failed.',
      data: { vaultId: vault.id }
    })
  }

  return expiredVaults.length
}