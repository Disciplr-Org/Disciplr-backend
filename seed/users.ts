import type { Knex } from 'knex'

export interface User {
  id: string
  email: string
  name: string
  status: 'active' | 'inactive' | 'admin'
  created_at: Date
  updated_at: Date
}

const sampleUsers: Omit<User, 'id' | 'created_at' | 'updated_at'>[] = [
  {
    email: 'john.doe@example.com',
    name: 'John Doe',
    status: 'active'
  },
  {
    email: 'jane.smith@example.com',
    name: 'Jane Smith',
    status: 'active'
  },
  {
    email: 'admin@disciplr.com',
    name: 'Admin User',
    status: 'admin'
  },
  {
    email: 'inactive.user@example.com',
    name: 'Inactive User',
    status: 'inactive'
  },
  {
    email: 'alice.johnson@example.com',
    name: 'Alice Johnson',
    status: 'active'
  },
  {
    email: 'bob.wilson@example.com',
    name: 'Bob Wilson',
    status: 'inactive'
  },
  {
    email: 'super.admin@disciplr.com',
    name: 'Super Admin',
    status: 'admin'
  }
]

export async function seedUsers(db: Knex) {
  console.log('🌱 Seeding users...')

  try {
    // Check if users table exists, create if it doesn't
    const tableExists = await db.schema.hasTable('users')
    if (!tableExists) {
      console.log('📋 Creating users table...')
      await db.schema.createTable('users', (table) => {
        table.string('id', 64).primary()
        table.string('email', 255).notNullable().unique()
        table.string('name', 255).notNullable()
        table
          .enu('status', ['active', 'inactive', 'admin'], {
            useNative: true,
            enumName: 'user_status',
          })
          .notNullable()
          .defaultTo('active')
        table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(db.fn.now())
        
        // Indexes
        table.index(['email'], 'idx_users_email')
        table.index(['status'], 'idx_users_status')
      })
      console.log('✅ Users table created')
    }

    // Insert or update users
    let insertedCount = 0
    let updatedCount = 0

    for (const userData of sampleUsers) {
      const userId = userData.email.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase()
      
      const existingUser = await db('users').where('email', userData.email).first()
      
      if (existingUser) {
        // Update existing user
        await db('users')
          .where('email', userData.email)
          .update({
            ...userData,
            updated_at: new Date()
          })
        updatedCount++
        console.log(`🔄 Updated user: ${userData.email}`)
      } else {
        // Insert new user
        await db('users').insert({
          id: userId,
          ...userData,
          created_at: new Date(),
          updated_at: new Date()
        })
        insertedCount++
        console.log(`➕ Inserted user: ${userData.email}`)
      }
    }

    console.log(`✅ Users seeding completed: ${insertedCount} inserted, ${updatedCount} updated`)
    
    // Display summary
    const totalUsers = await db('users').count('* as count').first()
    const activeUsers = await db('users').where('status', 'active').count('* as count').first()
    const inactiveUsers = await db('users').where('status', 'inactive').count('* as count').first()
    const adminUsers = await db('users').where('status', 'admin').count('* as count').first()
    
    console.log(`📊 Users Summary:`)
    console.log(`   Total: ${totalUsers?.count || 0}`)
    console.log(`   Active: ${activeUsers?.count || 0}`)
    console.log(`   Inactive: ${inactiveUsers?.count || 0}`)
    console.log(`   Admin: ${adminUsers?.count || 0}`)
    
  } catch (error) {
    console.error('❌ Error seeding users:', error)
    throw error
  }
}
