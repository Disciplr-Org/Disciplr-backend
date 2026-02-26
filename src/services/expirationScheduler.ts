import { checkExpiredVaults } from './vaultTransitions.js'

let intervalId: ReturnType<typeof setInterval> | null = null

export const startExpirationChecker = (intervalMs = 60_000): void => {
  if (intervalId) return

  intervalId = setInterval(() => {
    const expired = checkExpiredVaults()
    if (expired.length > 0) {
      console.log(`[ExpirationChecker] Failed ${expired.length} expired vault(s): ${expired.join(', ')}`)
    }
  }, intervalMs)

  intervalId.unref()
}

export const stopExpirationChecker = (): void => {
  if (intervalId) {
    clearInterval(intervalId)
    intervalId = null
  }
}
