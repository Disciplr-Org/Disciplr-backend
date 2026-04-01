import { Server } from '@stellar/stellar-sdk'
import { db } from '../db/knex.js'
import { getValidatedConfig } from '../config/horizonListener.js'
import { markVaultExpiries } from './vault.js'

let monitorInterval: NodeJS.Timeout | null = null

/**
 * Checks the lag between the latest ledger on Horizon and the last processed ledger.
 */
export const checkListenerLag = async (): Promise<void> => {
  try {
    const config = getValidatedConfig()
    const server = new Server(config.horizonUrl)
    
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

    if (lag > config.lagThreshold) {
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
