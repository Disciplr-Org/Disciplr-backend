import { checkExpiredVaults } from './vaultTransitions.js'
import { db } from '../db/index.js'

const BATCH_SIZE = 50

let intervalId: ReturnType<typeof setInterval> | null = null

const processExpiredVaultsBatch = async (): Promise<string[]> => {
  const failed: string[] = []

  try {
    const expiredVaults = await db('vaults')
      .where('status', 'active')
      .where('end_date', '<=', new Date())
      .limit(BATCH_SIZE)

    if (expiredVaults.length === 0) {
      return failed
    }

    for (const vault of expiredVaults) {
      try {
        await db('vaults')
          .where('id', vault.id)
          .where('status', 'active')
          .update({ status: 'failed' })
        failed.push(vault.id)
      } catch (error) {
        console.error(`[ExpirationChecker] Failed to mark vault ${vault.id} as failed:`, error)
      }
    }

    if (failed.length > 0) {
      console.log(`[ExpirationChecker] Failed ${failed.length} expired vault(s): ${failed.join(', ')}`)
    }
  } catch (error) {
    console.error('[ExpirationChecker] Error processing expired vaults:', error)
  }

  return failed
}

export const startExpirationChecker = (intervalMs = 60_000): void => {
  if (intervalId) return

  const runCheck = async () => {
    try {
      await processExpiredVaultsBatch()
    } catch (error) {
      console.error('[ExpirationChecker] Check failed:', error)
    }
  }

  runCheck()

  intervalId = setInterval(runCheck, intervalMs)
  intervalId.unref()
}

export const stopExpirationChecker = (): void => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
