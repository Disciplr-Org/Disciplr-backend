const GLOBAL_PAUSE_KEY = 'webhook_delivery:global_pause'

let sharedRedisClient: any | undefined

const getRedisClient = (): any | undefined => {
  if (sharedRedisClient !== undefined) return sharedRedisClient

  const redisUrl = process.env.REDIS_URL
  if (redisUrl) {
    const Redis = require('ioredis') as any
    sharedRedisClient = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    })
    return sharedRedisClient
  }
  return undefined
}

// In-memory fallback if Redis is not configured (e.g. for testing)
let fallbackInMemoryFlag = false

export const isPaused = async (): Promise<boolean> => {
  const client = getRedisClient()
  if (client) {
    const val = await client.get(GLOBAL_PAUSE_KEY)
    return val !== null
  }
  return fallbackInMemoryFlag
}

export const pauseDelivery = async (): Promise<void> => {
  const client = getRedisClient()
  if (client) {
    await client.set(GLOBAL_PAUSE_KEY, new Date().toISOString())
  } else {
    fallbackInMemoryFlag = true
  }
}

export const resumeDelivery = async (): Promise<void> => {
  const client = getRedisClient()
  if (client) {
    await client.del(GLOBAL_PAUSE_KEY)
  } else {
    fallbackInMemoryFlag = false
  }
}

/** Exposed for tests to reset the fallback memory flag */
export const resetFallbackFlag = (): void => {
  fallbackInMemoryFlag = false
}

export const closePauseStore = async (): Promise<void> => {
  if (sharedRedisClient) {
    await sharedRedisClient.quit()
    sharedRedisClient = undefined
  }
}
