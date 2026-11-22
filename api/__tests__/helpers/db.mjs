import pg from 'pg'
import { Keypair } from '@stellar/stellar-sdk'

const { Pool } = pg

let poolInstance = null

export function getTestPool() {
  const url = process.env.DATABASE_URL
  if (!url) return null
  if (!poolInstance) {
    poolInstance = new Pool({
      connectionString: url,
      max: 5,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    })
  }
  return poolInstance
}

export async function closeTestPool() {
  if (poolInstance) {
    await poolInstance.end()
    poolInstance = null
  }
}

export async function truncateDb() {
  const pool = getTestPool()
  if (!pool) return
  // Truncate tables between tests to ensure clean state
  await pool.query('TRUNCATE TABLE rate_limit_buckets, activity_log, milestones, vaults CASCADE').catch(() => {
    return pool.query('TRUNCATE TABLE activity_log, milestones, vaults CASCADE')
  })
}

export function randomStellarAddress() {
  return Keypair.random().publicKey()
}

export function buildVaultPayload(overrides = {}) {
  const creator = overrides.creator || randomStellarAddress()
  const verifier = overrides.verifier || randomStellarAddress()
  const now = Date.now()
  const startDate = overrides.startDate || new Date(now).toISOString()
  const endDate = overrides.endDate || new Date(now + 30 * 86400000).toISOString()

  return {
    name: 'Test Commitment Vault',
    creator,
    verifier,
    amount: 1000,
    startDate,
    endDate,
    successDestination: overrides.successDestination || creator,
    failureDestination: overrides.failureDestination || verifier,
    milestones: [
      {
        title: 'Milestone 1',
        amount: 400,
        dueDate: new Date(now + 10 * 86400000).toISOString(),
      },
      {
        title: 'Milestone 2',
        amount: 600,
        dueDate: new Date(now + 20 * 86400000).toISOString(),
      },
    ],
    ...overrides,
  }
}
