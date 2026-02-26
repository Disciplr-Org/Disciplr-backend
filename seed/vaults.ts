import type { Knex } from 'knex'

export interface Vault {
  id: string
  creator: string
  amount: number
  start_timestamp: Date
  end_timestamp: Date
  success_destination: string
  failure_destination: string
  status: 'active' | 'completed' | 'failed' | 'cancelled'
  created_at: Date
}

const sampleVaults: Omit<Vault, 'id' | 'created_at'>[] = [
  {
    creator: 'john.doe@example.com',
    amount: 1000.00,
    start_timestamp: new Date('2024-01-01T00:00:00Z'),
    end_timestamp: new Date('2024-12-31T23:59:59Z'),
    success_destination: '0x1234567890123456789012345678901234567890',
    failure_destination: '0x0987654321098765432109876543210987654321',
    status: 'active'
  },
  {
    creator: 'jane.smith@example.com',
    amount: 2500.50,
    start_timestamp: new Date('2024-02-15T00:00:00Z'),
    end_timestamp: new Date('2024-08-15T23:59:59Z'),
    success_destination: '0x2345678901234567890123456789012345678901',
    failure_destination: '0x2109876543210987654321098765432109876543',
    status: 'completed'
  },
  {
    creator: 'alice.johnson@example.com',
    amount: 500.00,
    start_timestamp: new Date('2024-03-01T00:00:00Z'),
    end_timestamp: new Date('2024-06-01T23:59:59Z'),
    success_destination: '0x3456789012345678901234567890123456789012',
    failure_destination: '0x3210987654321098765432109876543210987654',
    status: 'failed'
  },
  {
    creator: 'bob.wilson@example.com',
    amount: 750.25,
    start_timestamp: new Date('2024-04-10T00:00:00Z'),
    end_timestamp: new Date('2024-10-10T23:59:59Z'),
    success_destination: '0x4567890123456789012345678901234567890123',
    failure_destination: '0x4321098765432109876543210987654321098765',
    status: 'cancelled'
  },
  {
    creator: 'john.doe@example.com',
    amount: 3000.00,
    start_timestamp: new Date('2024-05-01T00:00:00Z'),
    end_timestamp: new Date('2025-05-01T23:59:59Z'),
    success_destination: '0x5678901234567890123456789012345678901234',
    failure_destination: '0x5432109876543210987654321098765432109876',
    status: 'active'
  },
  {
    creator: 'jane.smith@example.com',
    amount: 1500.75,
    start_timestamp: new Date('2023-11-01T00:00:00Z'),
    end_timestamp: new Date('2024-03-01T23:59:59Z'),
    success_destination: '0x6789012345678901234567890123456789012345',
    failure_destination: '0x6543210987654321098765432109876543210987',
    status: 'completed'
  },
  {
    creator: 'alice.johnson@example.com',
    amount: 2000.00,
    start_timestamp: new Date('2024-06-15T00:00:00Z'),
    end_timestamp: new Date('2024-09-15T23:59:59Z'),
    success_destination: '0x7890123456789012345678901234567890123456',
    failure_destination: '0x7654321098765432109876543210987654321098',
    status: 'failed'
  },
  {
    creator: 'admin@disciplr.com',
    amount: 10000.00,
    start_timestamp: new Date('2024-01-15T00:00:00Z'),
    end_timestamp: new Date('2024-07-15T23:59:59Z'),
    success_destination: '0x8901234567890123456789012345678901234567',
    failure_destination: '0x8765432109876543210987654321098765432109',
    status: 'completed'
  }
]

export async function seedVaults(db: Knex) {
  console.log('🌱 Seeding vaults...')

  try {
    // Check if vaults table exists
    const tableExists = await db.schema.hasTable('vaults')
    if (!tableExists) {
      console.log('❌ Vaults table does not exist. Please run migrations first.')
      throw new Error('Vaults table not found')
    }

    // Insert or update vaults
    let insertedCount = 0
    let updatedCount = 0

    for (const vaultData of sampleVaults) {
      const vaultId = `vault_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      // Check if vault with same creator and amount already exists
      const existingVault = await db('vaults')
        .where('creator', vaultData.creator)
        .where('amount', vaultData.amount)
        .first()

      if (existingVault) {
        // Update existing vault
        await db('vaults')
          .where('id', existingVault.id)
          .update(vaultData)
        updatedCount++
        console.log(`🔄 Updated vault for ${vaultData.creator}: $${vaultData.amount}`)
      } else {
        // Insert new vault
        await db('vaults').insert({
          id: vaultId,
          ...vaultData,
          created_at: new Date()
        })
        insertedCount++
        console.log(`➕ Inserted vault for ${vaultData.creator}: $${vaultData.amount}`)
      }
    }

    console.log(`✅ Vaults seeding completed: ${insertedCount} inserted, ${updatedCount} updated`)
    
    // Display summary
    const totalVaults = await db('vaults').count('* as count').first()
    const activeVaults = await db('vaults').where('status', 'active').count('* as count').first()
    const completedVaults = await db('vaults').where('status', 'completed').count('* as count').first()
    const failedVaults = await db('vaults').where('status', 'failed').count('* as count').first()
    const cancelledVaults = await db('vaults').where('status', 'cancelled').count('* as count').first()
    
    console.log(`📊 Vaults Summary:`)
    console.log(`   Total: ${totalVaults?.count || 0}`)
    console.log(`   Active: ${activeVaults?.count || 0}`)
    console.log(`   Completed: ${completedVaults?.count || 0}`)
    console.log(`   Failed: ${failedVaults?.count || 0}`)
    console.log(`   Cancelled: ${cancelledVaults?.count || 0}`)
    
  } catch (error) {
    console.error('❌ Error seeding vaults:', error)
    throw error
  }
}
