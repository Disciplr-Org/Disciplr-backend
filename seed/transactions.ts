import type { Knex } from 'knex'

export interface Transaction {
  id: string
  vault_id: string
  user_id: string
  amount: number
  type: 'deposit' | 'withdrawal' | 'refund'
  status: 'success' | 'pending' | 'failed'
  transaction_hash?: string
  description: string
  created_at: Date
  updated_at: Date
}

const sampleTransactions: Omit<Transaction, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    vault_id: 'vault_1', // Will be updated with actual vault ID
    user_id: 'john.doe@example.com',
    amount: 250.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xabc123def4567890123456789012345678901234567890123456789012345678',
    description: 'Initial deposit for Q1 goal'
  },
  {
    vault_id: 'vault_1',
    user_id: 'john.doe@example.com',
    amount: 225.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xbcd234efg5678901234567890123456789012345678901234567890123456789',
    description: 'Additional contribution'
  },
  {
    vault_id: 'vault_2',
    user_id: 'jane.smith@example.com',
    amount: 500.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xcde345fgh6789012345678901234567890123456789012345678901234567890',
    description: 'Initial deposit milestone'
  },
  {
    vault_id: 'vault_2',
    user_id: 'jane.smith@example.com',
    amount: 600.00,
    type: 'deposit',
    status: 'pending',
    transaction_hash: null,
    description: 'Pending contribution for halfway point'
  },
  {
    vault_id: 'vault_3',
    user_id: 'alice.johnson@example.com',
    amount: 200.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xdef456ghi7890123456789012345678901234567890123456789012345678901',
    description: 'Emergency fund contribution'
  },
  {
    vault_id: 'vault_3',
    user_id: 'alice.johnson@example.com',
    amount: 100.00,
    type: 'withdrawal',
    status: 'failed',
    transaction_hash: null,
    description: 'Failed withdrawal attempt'
  },
  {
    vault_id: 'vault_4',
    user_id: 'bob.wilson@example.com',
    amount: 300.00,
    type: 'deposit',
    status: 'pending',
    transaction_hash: null,
    description: 'Vacation savings deposit'
  },
  {
    vault_id: 'vault_5',
    user_id: 'john.doe@example.com',
    amount: 850.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xefg567hij8901234567890123456789012345678901234567890123456789012',
    description: 'Investment readiness contribution'
  },
  {
    vault_id: 'vault_6',
    user_id: 'jane.smith@example.com',
    amount: 1500.75,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xfgh678ijk9012345678901234567890123456789012345678901234567890123',
    description: 'Year-end bonus completed'
  },
  {
    vault_id: 'vault_7',
    user_id: 'alice.johnson@example.com',
    amount: 1200.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xghi789jkl0123456789012345678901234567890123456789012345678901234',
    description: 'Home renovation partial payment'
  },
  {
    vault_id: 'vault_7',
    user_id: 'alice.johnson@example.com',
    amount: 50.00,
    type: 'withdrawal',
    status: 'failed',
    transaction_hash: null,
    description: 'Failed withdrawal due to insufficient funds'
  },
  {
    vault_id: 'vault_8',
    user_id: 'admin@disciplr.com',
    amount: 10000.00,
    type: 'deposit',
    status: 'success',
    transaction_hash: '0xhij890klm1234567890123456789012345678901234567890123456789012345',
    description: 'Retirement fund starter completed'
  },
  {
    vault_id: 'vault_1',
    user_id: 'john.doe@example.com',
    amount: 25.00,
    type: 'refund',
    status: 'success',
    transaction_hash: '0xijk901lmn2345678901234567890123456789012345678901234567890123456',
    description: 'Refund for overpayment'
  },
  {
    vault_id: 'vault_2',
    user_id: 'jane.smith@example.com',
    amount: 150.00,
    type: 'deposit',
    status: 'pending',
    transaction_hash: null,
    description: 'Pending milestone bonus'
  },
  {
    vault_id: 'vault_5',
    user_id: 'john.doe@example.com',
    amount: 2150.00,
    type: 'deposit',
    status: 'pending',
    transaction_hash: null,
    description: 'Large pending deposit'
  }
]

export async function seedTransactions(db: Knex) {
  console.log('🌱 Seeding transactions...')

  try {
    // Check if transactions table exists, create if it doesn't
    const tableExists = await db.schema.hasTable('transactions')
    if (!tableExists) {
      console.log('📋 Creating transactions table...')
      await db.schema.createTable('transactions', (table) => {
        table.string('id', 64).primary()
        table.string('vault_id', 64).notNullable()
        table.string('user_id', 255).notNullable()
        table.decimal('amount', 36, 7).notNullable()
        table
          .enu('type', ['deposit', 'withdrawal', 'refund'], {
            useNative: true,
            enumName: 'transaction_type',
          })
          .notNullable()
        table
          .enu('status', ['success', 'pending', 'failed'], {
            useNative: true,
            enumName: 'transaction_status',
          })
          .notNullable()
          .defaultTo('pending')
        table.string('transaction_hash', 255).nullable()
        table.text('description').notNullable()
        table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        
        // Foreign key constraints
        table.foreign('vault_id').references('id').inTable('vaults').onDelete('CASCADE')
        
        // Indexes
        table.index(['vault_id'], 'idx_transactions_vault_id')
        table.index(['user_id'], 'idx_transactions_user_id')
        table.index(['status'], 'idx_transactions_status')
        table.index(['type'], 'idx_transactions_type')
        table.index(['transaction_hash'], 'idx_transactions_hash')
      })
      console.log('✅ Transactions table created')
    }

    // Get existing vaults to map vault_id references
    const vaults = await db('vaults').select('id', 'creator')
    if (vaults.length === 0) {
      console.log('⚠️  No vaults found. Please run vault seeding first.')
      return
    }

    console.log(`📋 Found ${vaults.length} vaults for transaction mapping`)

    // Insert or update transactions
    let insertedCount = 0
    let updatedCount = 0

    for (let i = 0; i < sampleTransactions.length; i++) {
      const vaultIndex = i % vaults.length
      const transactionData = {
        ...sampleTransactions[i],
        vault_id: vaults[vaultIndex].id, // Map to actual vault ID
        user_id: vaults[vaultIndex].creator // Use vault creator as user
      }
      
      const transactionId = `txn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      // Check if transaction with same description and vault already exists
      const existingTransaction = await db('transactions')
        .where('vault_id', transactionData.vault_id)
        .where('description', transactionData.description)
        .first()

      if (existingTransaction) {
        // Update existing transaction
        await db('transactions')
          .where('id', existingTransaction.id)
          .update({
            ...transactionData,
            updated_at: new Date()
          })
        updatedCount++
        console.log(`🔄 Updated transaction: ${transactionData.description}`)
      } else {
        // Insert new transaction
        await db('transactions').insert({
          id: transactionId,
          ...transactionData,
          created_at: new Date(),
          updated_at: new Date()
        })
        insertedCount++
        console.log(`➕ Inserted transaction: ${transactionData.description}`)
      }
    }

    console.log(`✅ Transactions seeding completed: ${insertedCount} inserted, ${updatedCount} updated`)
    
    // Display summary
    const totalTransactions = await db('transactions').count('* as count').first()
    const successTransactions = await db('transactions').where('status', 'success').count('* as count').first()
    const pendingTransactions = await db('transactions').where('status', 'pending').count('* as count').first()
    const failedTransactions = await db('transactions').where('status', 'failed').count('* as count').first()
    
    const depositTransactions = await db('transactions').where('type', 'deposit').count('* as count').first()
    const withdrawalTransactions = await db('transactions').where('type', 'withdrawal').count('* as count').first()
    const refundTransactions = await db('transactions').where('type', 'refund').count('* as count').first()
    
    console.log(`📊 Transactions Summary:`)
    console.log(`   Total: ${totalTransactions?.count || 0}`)
    console.log(`   By Status - Success: ${successTransactions?.count || 0}, Pending: ${pendingTransactions?.count || 0}, Failed: ${failedTransactions?.count || 0}`)
    console.log(`   By Type - Deposits: ${depositTransactions?.count || 0}, Withdrawals: ${withdrawalTransactions?.count || 0}, Refunds: ${refundTransactions?.count || 0}`)
    
  } catch (error) {
    console.error('❌ Error seeding transactions:', error)
    throw error
  }
}
