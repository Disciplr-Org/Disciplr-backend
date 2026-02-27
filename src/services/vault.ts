import db from '../db/index.js'
import { createNotification } from './notification.js'

export interface VaultRecord {
  id: string
  creator: string
  amount: string
  start_timestamp: string
  end_timestamp: string
  success_destination: string
  failure_destination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  created_at: string
}

export const createVault = async (data: Partial<VaultRecord>): Promise<VaultRecord> => {
  const [vault] = await db('vaults')
    .insert({
      id: data.id,
      creator: data.creator,
      amount: data.amount,
      start_timestamp: data.start_timestamp,
      end_timestamp: data.end_timestamp,
      success_destination: data.success_destination,
      failure_destination: data.failure_destination,
      status: data.status || 'active',
    })
    .returning('*')
  return vault
}

export const listVaults = async (filters: any = {}): Promise<VaultRecord[]> => {
  let query = db('vaults').select('*')
  
  if (filters.status) {
    query = query.where({ status: filters.status })
  }
  
  if (filters.creator) {
    query = query.where({ creator: filters.creator })
  }
  
  return query.orderBy('created_at', 'desc')
}

export const getVaultById = async (id: string): Promise<VaultRecord | null> => {
  return db('vaults').where({ id }).first()
}

/**
 * Finds active vaults past their deadline and marks them as failed.
 * Creates notifications for the creators.
 */
export const markVaultExpiries = async (): Promise<number> => {
  const now = new Date().toISOString()
  
  const expiredVaults = await db('vaults')
    .where('status', 'active')
    .andWhere('end_timestamp', '<', now)
    .select('*')
    
  if (expiredVaults.length === 0) return 0
  
  const expiredIds = expiredVaults.map(v => v.id)
  
  await db('vaults')
    .whereIn('id', expiredIds)
    .update({ status: 'failed' })
    
  // Create notifications for each expired vault
  for (const vault of expiredVaults) {
    await createNotification({
      user_id: vault.creator,
      type: 'vault_failure',
      title: 'Vault Deadline Reached',
      message: `Vault ${vault.id} has expired and been marked as failed.`,
      data: { vaultId: vault.id }
    })
  }
  
  return expiredVaults.length
}
