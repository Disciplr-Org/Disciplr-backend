import type { Store, Options, ClientRateLimitInfo } from 'express-rate-limit'
import type Redis from 'ioredis'

export class RedisStore implements Store {
  private redis: Redis
  private prefix: string
  private windowMs: number

  constructor(redis: Redis, prefix: string = 'rl:') {
    this.redis = redis
    this.prefix = prefix
    this.windowMs = 60000 // Default, will be overridden in init()
  }

  init(options: Options): void {
    this.windowMs = options.windowMs
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redisKey = `${this.prefix}${key}`
    try {
      // Use multi to INCR and get PTTL in one atomic round-trip
      const results = await this.redis
        .multi()
        .incr(redisKey)
        .pttl(redisKey)
        .exec()

      if (!results) {
        throw new Error('Redis multi execution failed')
      }

      const incrResult = results[0] as [Error | null, unknown]
      const pttlResult = results[1] as [Error | null, unknown]

      if (incrResult[0]) throw incrResult[0]
      if (pttlResult[0]) throw pttlResult[0]

      const hits = Number(incrResult[1])
      let pttl = Number(pttlResult[1])

      if (pttl === -1) {
        // No expiry was set (key was just created or missing expiry)
        // We set it in a fire-and-forget manner to keep response fast,
        // or await it if we want to ensure atomicity. We will await it.
        await this.redis.pexpire(redisKey, this.windowMs)
        pttl = this.windowMs
      }

      const resetTime = new Date(Date.now() + (pttl > 0 ? pttl : this.windowMs))

      return {
        totalHits: hits,
        resetTime,
      }
    } catch (error) {
      console.warn(`[RATE_LIMIT_STORE_ERROR] Failed to increment rate limit for key ${key}:`, error)
      // Fail-open semantics: allow the request if the store fails (return 1 to satisfy positive integer validation)
      return {
        totalHits: 1,
        resetTime: undefined,
      }
    }
  }

  async decrement(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`
    try {
      await this.redis.decr(redisKey)
    } catch (error) {
      console.warn(`[RATE_LIMIT_STORE_ERROR] Failed to decrement rate limit for key ${key}:`, error)
    }
  }

  async resetKey(key: string): Promise<void> {
    const redisKey = `${this.prefix}${key}`
    try {
      await this.redis.del(redisKey)
    } catch (error) {
      console.warn(`[RATE_LIMIT_STORE_ERROR] Failed to reset rate limit for key ${key}:`, error)
    }
  }
}
