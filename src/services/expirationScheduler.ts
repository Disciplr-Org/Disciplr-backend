import db from '../db/index.js'
import { BackgroundJobSystem } from '../jobs/system.js'
import { getIdempotentResponse, saveIdempotentResponse } from './idempotency.js'

const BATCH_SIZE = 50

let intervalId: ReturnType<typeof setInterval> | null = null

// Module-level default job system instance.
// Tests can inject a different instance via startExpirationChecker's jobSystem param.
let _defaultJobSystem: BackgroundJobSystem | null = null

const getDefaultJobSystem = (): BackgroundJobSystem => {
  if (!_defaultJobSystem) {
    _defaultJobSystem = new BackgroundJobSystem()
  }
  return _defaultJobSystem
}

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

const enqueueSlashJobs = async (expired: string[], jobSystem: BackgroundJobSystem): Promise<void> => {
  for (const vaultId of expired) {
    if (process.env.DRY_RUN === 'true') {
      console.log(`[ExpirationChecker] DRY_RUN: skipping enqueue for vault ${vaultId}`)
      continue
    }
    const idempotencyKey = `slash_on_miss:${vaultId}`
    const hash = vaultId
    const existing = await getIdempotentResponse(idempotencyKey, hash)
    if (existing) continue
    jobSystem.enqueue('deadline.check', {
      vaultId,
      triggerSource: 'expiration-scheduler',
    }, { maxAttempts: 3 })
    await saveIdempotentResponse(idempotencyKey, hash, vaultId, { enqueued: true })
  }
}

export const startExpirationChecker = (intervalMs = 60_000, jobSystem?: BackgroundJobSystem): void => {
  if (intervalId) return

  const resolvedJobSystem = jobSystem ?? getDefaultJobSystem()

  const runCheck = async () => {
    try {
      const expired = await processExpiredVaultsBatch()
      await enqueueSlashJobs(expired, resolvedJobSystem)
    } catch (error) {
      console.error('[ExpirationChecker] Check failed:', error)
    }
  }

  runCheck()

  intervalId = setInterval(async () => {
    await runCheck()
  }, intervalMs)
  intervalId.unref()
}

export const stopExpirationChecker = (): void => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
