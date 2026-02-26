import knex from 'knex'
import { seedUsers } from './users.js'
import { seedVaults } from './vaults.js'
import { seedMilestones } from './milestones.js'
import { seedTransactions } from './transactions.js'

const dbConfig = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  pool: {
    min: 2,
    max: 10,
  },
}

const db = knex(dbConfig)

export { db }

async function main() {
  const command = process.argv[2]
  
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ Seed scripts cannot be run in production environment')
    process.exit(1)
  }

  console.log('🌱 Starting database seeding...')

  try {
    switch (command) {
      case 'users':
        await seedUsers(db)
        break
      case 'vaults':
        await seedVaults(db)
        break
      case 'milestones':
        await seedMilestones(db)
        break
      case 'transactions':
        await seedTransactions(db)
        break
      case 'all':
        await seedUsers(db)
        await seedVaults(db)
        await seedMilestones(db)
        await seedTransactions(db)
        break
      default:
        console.log('Usage: npm run seed [users|vaults|milestones|transactions|all]')
        process.exit(1)
    }

    console.log('✅ Seeding completed successfully!')
  } catch (error) {
    console.error('❌ Seeding failed:', error)
    process.exit(1)
  } finally {
    await db.destroy()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
