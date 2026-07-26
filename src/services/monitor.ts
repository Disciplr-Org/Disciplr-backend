import * as StellarSdk from '@stellar/stellar-sdk'
import { db } from '../db/knex.js'
import { getValidatedConfig } from '../config/horizonListener.js'
import { markVaultExpiries } from './vaultExpiry.service.js'
import { getPgPool } from '../db/pool.js'

const HorizonServer = (StellarSdk as any).Horizon?.Server ?? (StellarSdk as any).Server

let monitorInterval: NodeJS.Timeout | null = null
let _latestLag: number | undefined
let isRunning = false

function jobNameToAdvisoryLockKey(jobName: string): [number, number] {
  let h1 = 0xdeadbeef
  let h2 = 0xcafebabe
  for (let i = 0; i < jobName.length; i++) {
    h1 = Math.imul(31, h1) + jobName.charCodeAt(i)
    h2 = Math.imul(17, h2) + jobName.charCodeAt(i)
  }
  return [h1 | 0, h2 | 0]
}

async function tryAcquireLock(jobName: string): Promise<boolean> {
  const pool = getPgPool()
  if (!pool) return true

  const [key1, key2] = jobNameToAdvisoryLockKey(jobName)
  const client = await pool.connect()
  try {
    const result = await client.query('SELECT pg_try_advisory_lock($1, $2) as acquired', [key1, key2])
    return result.rows[0].acquired as boolean
  } catch (error) {
    console.error(`[Monitor] Failed to acquire advisory lock for ${jobName}:`, error)
    return false
  } finally {
    client.release()
  }
}

async function releaseLock(jobName: string): Promise<void> {
  const pool = getPgPool()
  if (!pool) return

  const [key1, key2] = jobNameToAdvisoryLockKey(jobName)
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_unlock($1, $2)', [key1, key2])
  } catch (error) {
    console.error(`[Monitor] Failed to release advisory lock for ${jobName}:`, error)
  } finally {
    client.release()
  }
}

/** Returns the most recent lag value measured by checkListenerLag, or undefined if not yet measured. */
export function getLatestListenerLag(): number | undefined {
  return _latestLag
}

/**
 * Checks the lag between the latest ledger on Horizon and the last processed ledger.
 */
export const checkListenerLag = async (): Promise<void> => {
  try {
    const config = getValidatedConfig()
    const server = new HorizonServer(config.horizonUrl)
    
    // Fetch latest ledger from Horizon
    const ledgerPage = await server.ledgers().order('desc').limit(1).call()
    if (!ledgerPage.records || ledgerPage.records.length === 0) {
      console.warn('[Monitor] Could not fetch latest ledger from Horizon')
      return
    }
    const latestLedger = ledgerPage.records[0].sequence

    // Fetch last processed ledger from DB
    const state = await db('listener_state')
      .where({ service_name: 'horizon_listener' })
      .first()
    
    const lastProcessedLedger = state?.last_processed_ledger ?? config.startLedger ?? 0
    const lag = latestLedger - lastProcessedLedger
    _latestLag = lag

    if (config.lagThreshold !== undefined && lag > config.lagThreshold) {
      console.warn(`[Monitor] Horizon listener lag detected: ${lag} ledgers (Threshold: ${config.lagThreshold})`)
      console.warn(`[Monitor] Latest ledger: ${latestLedger}, Last processed: ${lastProcessedLedger}`)
    }
  } catch (err) {
    // Log error but don't crash the monitor
    console.error('[Monitor] Error checking listener lag:', err)
  }
}

/**
 * Starts a background monitor that periodically checks for vault expiries and listener lag.
 * @param intervalMs How often to check for expiries (default: 1 minute)
 */
export const startDeadlineMonitor = (intervalMs: number = 60000): void => {
  if (monitorInterval) {
    console.warn('Deadline monitor is already running.')
    return
  }

  console.log(`Starting deadline monitor with interval ${intervalMs}ms...`)
  
  monitorInterval = setInterval(async () => {
    if (isRunning) {
      console.log(`[Monitor] Monitor loop already running locally, skipping`)
      return
    }

    const lockName = 'monitor.loop'
    const lockAcquired = await tryAcquireLock(lockName)
    if (!lockAcquired) {
      console.log(`[Monitor] Could not acquire lock for ${lockName}, skipping (another replica holds the lock)`)
      return
    }

    isRunning = true

    try {
      // Check vault expiries
      const expiredCount = await markVaultExpiries()
      if (expiredCount > 0) {
        console.log(`[Monitor] Processed ${expiredCount} expired vaults.`)
      }

      // Check listener lag
      await checkListenerLag()
    } catch (err) {
      console.error('[Monitor] Error during monitor update:', err)
    } finally {
      isRunning = false
      await releaseLock(lockName)
    }
  }, intervalMs)
}

/**
 * Stops the background monitor.
 */
export const stopDeadlineMonitor = (): void => {
  if (monitorInterval) {
    clearInterval(monitorInterval)
    monitorInterval = null
    console.log('Deadline monitor stopped.')
  }
}
