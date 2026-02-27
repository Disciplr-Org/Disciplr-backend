import { markVaultExpiries } from './vault.js'

let monitorInterval: NodeJS.Timeout | null = null

/**
 * Starts a background monitor that periodically checks for vault expiries.
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
      const expiredCount = await markVaultExpiries()
      if (expiredCount > 0) {
        console.log(`[Monitor] Processed ${expiredCount} expired vaults.`)
      }
    } catch (err) {
      console.error('[Monitor] Error during expiry check:', err)
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
