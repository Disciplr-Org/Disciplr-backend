import type { Knex } from 'knex'

export interface Milestone {
  id: string
  vault_id: string
  title: string
  description: string
  target_amount: number
  current_amount: number
  due_date: Date
  status: 'pending' | 'completed' | 'overdue'
  created_at: Date
  updated_at: Date
}

const sampleMilestones: Omit<Milestone, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    vault_id: 'vault_1', // Will be updated with actual vault ID
    title: 'First Quarter Goal',
    description: 'Reach 25% of the total savings goal',
    target_amount: 250.00,
    current_amount: 250.00,
    due_date: new Date('2024-03-31T23:59:59Z'),
    status: 'completed'
  },
  {
    vault_id: 'vault_1',
    title: 'Mid-Year Target',
    description: 'Reach 50% of the total savings goal',
    target_amount: 500.00,
    current_amount: 475.00,
    due_date: new Date('2024-06-30T23:59:59Z'),
    status: 'pending'
  },
  {
    vault_id: 'vault_2',
    title: 'Initial Deposit',
    description: 'Complete the initial deposit milestone',
    target_amount: 500.00,
    current_amount: 500.00,
    due_date: new Date('2024-02-28T23:59:59Z'),
    status: 'completed'
  },
  {
    vault_id: 'vault_2',
    title: 'Halfway Point',
    description: 'Reach halfway to the savings goal',
    target_amount: 1250.25,
    current_amount: 1100.00,
    due_date: new Date('2024-05-15T23:59:59Z'),
    status: 'overdue'
  },
  {
    vault_id: 'vault_3',
    title: 'Emergency Fund',
    description: 'Build emergency fund buffer',
    target_amount: 500.00,
    current_amount: 200.00,
    due_date: new Date('2024-04-30T23:59:59Z'),
    status: 'overdue'
  },
  {
    vault_id: 'vault_4',
    title: 'Vacation Savings',
    description: 'Save for summer vacation',
    target_amount: 750.25,
    current_amount: 0.00,
    due_date: new Date('2024-07-01T23:59:59Z'),
    status: 'pending'
  },
  {
    vault_id: 'vault_5',
    title: 'Investment Readiness',
    description: 'Reach amount ready for investment',
    target_amount: 1000.00,
    current_amount: 850.00,
    due_date: new Date('2024-08-31T23:59:59Z'),
    status: 'pending'
  },
  {
    vault_id: 'vault_6',
    title: 'Year End Bonus',
    description: 'Complete year-end savings bonus',
    target_amount: 1500.75,
    current_amount: 1500.75,
    due_date: new Date('2024-02-28T23:59:59Z'),
    status: 'completed'
  },
  {
    vault_id: 'vault_7',
    title: 'Home Renovation',
    description: 'Save for home renovation project',
    target_amount: 2000.00,
    current_amount: 1200.00,
    due_date: new Date('2024-08-15T23:59:59Z'),
    status: 'overdue'
  },
  {
    vault_id: 'vault_8',
    title: 'Retirement Fund Starter',
    description: 'Initial retirement fund contribution',
    target_amount: 10000.00,
    current_amount: 10000.00,
    due_date: new Date('2024-06-30T23:59:59Z'),
    status: 'completed'
  }
]

export async function seedMilestones(db: Knex) {
  console.log('🌱 Seeding milestones...')

  try {
    // Check if milestones table exists, create if it doesn't
    const tableExists = await db.schema.hasTable('milestones')
    if (!tableExists) {
      console.log('📋 Creating milestones table...')
      await db.schema.createTable('milestones', (table) => {
        table.string('id', 64).primary()
        table.string('vault_id', 64).notNullable()
        table.string('title', 255).notNullable()
        table.text('description')
        table.decimal('target_amount', 36, 7).notNullable()
        table.decimal('current_amount', 36, 7).notNullable().defaultTo(0)
        table.timestamp('due_date', { useTz: true }).notNullable()
        table
          .enu('status', ['pending', 'completed', 'overdue'], {
            useNative: true,
            enumName: 'milestone_status',
          })
          .notNullable()
          .defaultTo('pending')
        table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        
        // Foreign key constraint
        table.foreign('vault_id').references('id').inTable('vaults').onDelete('CASCADE')
        
        // Indexes
        table.index(['vault_id'], 'idx_milestones_vault_id')
        table.index(['status'], 'idx_milestones_status')
        table.index(['due_date'], 'idx_milestones_due_date')
      })
      console.log('✅ Milestones table created')
    }

    // Get existing vaults to map vault_id references
    const vaults = await db('vaults').select('id', 'creator', 'amount')
    if (vaults.length === 0) {
      console.log('⚠️  No vaults found. Please run vault seeding first.')
      return
    }

    console.log(`📋 Found ${vaults.length} vaults for milestone mapping`)

    // Insert or update milestones
    let insertedCount = 0
    let updatedCount = 0

    for (let i = 0; i < sampleMilestones.length && i < vaults.length; i++) {
      const milestoneData = {
        ...sampleMilestones[i],
        vault_id: vaults[i].id // Map to actual vault ID
      }
      
      const milestoneId = `milestone_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      // Check if milestone with same title and vault already exists
      const existingMilestone = await db('milestones')
        .where('vault_id', milestoneData.vault_id)
        .where('title', milestoneData.title)
        .first()

      if (existingMilestone) {
        // Update existing milestone
        await db('milestones')
          .where('id', existingMilestone.id)
          .update({
            ...milestoneData,
            updated_at: new Date()
          })
        updatedCount++
        console.log(`🔄 Updated milestone: ${milestoneData.title}`)
      } else {
        // Insert new milestone
        await db('milestones').insert({
          id: milestoneId,
          ...milestoneData,
          created_at: new Date(),
          updated_at: new Date()
        })
        insertedCount++
        console.log(`➕ Inserted milestone: ${milestoneData.title}`)
      }
    }

    console.log(`✅ Milestones seeding completed: ${insertedCount} inserted, ${updatedCount} updated`)
    
    // Display summary
    const totalMilestones = await db('milestones').count('* as count').first()
    const pendingMilestones = await db('milestones').where('status', 'pending').count('* as count').first()
    const completedMilestones = await db('milestones').where('status', 'completed').count('* as count').first()
    const overdueMilestones = await db('milestones').where('status', 'overdue').count('* as count').first()
    
    console.log(`📊 Milestones Summary:`)
    console.log(`   Total: ${totalMilestones?.count || 0}`)
    console.log(`   Pending: ${pendingMilestones?.count || 0}`)
    console.log(`   Completed: ${completedMilestones?.count || 0}`)
    console.log(`   Overdue: ${overdueMilestones?.count || 0}`)
    
  } catch (error) {
    console.error('❌ Error seeding milestones:', error)
    throw error
  }
}
