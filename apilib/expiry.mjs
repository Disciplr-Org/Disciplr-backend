// Cron job and core logic for expiring overdue active vaults.
import { timingSafeEqual } from 'node:crypto'
import { getStore } from './store.mjs'

/**
 * Constant-time comparison of two strings to prevent timing attacks.
 */
export function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * Resolve an expiry timestamp for an API key.
 *
 * Returns null when no expiry is requested and no default TTL is configured.
 * Throws a RangeError when expiresInDays is outside the allowed bounds or not an integer.
 *
 * @param {number|undefined|null} expiresInDays
 * @param {Date|string|number} [now] Injected clock for testing (default: Date.now())
 * @param {number} [minDays] Minimum allowed TTL in days (default: 1)
 * @param {number} [maxDays] Maximum allowed TTL in days (default: 365)
 * @returns {Date|null}
 */
export function resolveExpiresAt(expiresInDays, now = new Date(), minDays = 1, maxDays = 365) {
  if (expiresInDays === undefined || expiresInDays === null) return null
  if (typeof expiresInDays !== 'number' || !Number.isInteger(expiresInDays)) {
    throw new RangeError('expiresInDays must be an integer')
  }
  if (expiresInDays < minDays || expiresInDays > maxDays) {
    throw new RangeError((`expiresInDays must be between ${minDays} and ${maxDays}`))
  }
  const base = now instanceof Date ? now.getTime() : new Date(now).getTime()
  return new Date(base + expiresInDays * 24 * 60 * 60 * 1000)
}

/**
 * Resolve the rotation grace window in seconds from the environment.
 * Defaults to 86400 (24h); 0 disables the overlap window.
 */
export function resolveRotationGraceSecs(env = process.env) {
  const raw = env.API_KEY_ROTATION_GRACE_SECS
  if (raw === undefined || raw === null || raw === '') return 86400
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0) return 86400
  return Math.floor(parsed)
}

/**
 * Resolve the optional org-level default TTL in days from the environment.
 * Returns null when unset or invalid.
 */
export function resolveDefaultTtlDays(env = process.env) {
  const raw = env.API_KEY_DEFAULT_TTL_DAYS
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 365) return null
  return parsed
}

/**
 * Determine whether an API key record is expired at the given instant.
 * Compares against a consistent UTC clock so the result is DT-free.
 */
export function isExpired(record, now = new Date()) {
  if (!record || !record.expiresAt) return false
  const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : new Date(record.expiresAt)
  const nowDate = now instanceof Date ? now : new Date(now)
  return expiresAt.getTime() <= nowDate.getTime()
}

/**
 * Determine whether the previous secret is still within its rotation grace window.
 */
export function isPreviousKeyInGrace(record, now = new Date()) {
  if (!record || !record.previousKeyHash || !record.previousValidUntil) return false
  const until = record.previousValidUntil instanceof Date
    ? record.previousValidUntil
    : new Date(record.previousValidUntil)
  const nowDate = now instanceof Date ? now : new Date(now)
  return nowDate.getTime() < until.getTime()
}

/**
 * Expire overdue active vaults in batches of up to batchSize.
 *
 * @param {Object} [options]
 * @param {Date|string|number} [options.now] Injected clock for testing (default: Date.now())
 * @param {number} [options.batchSize] Max vaults to process in this run (default: 100)
 * @param {Object} [options.store] Store instance (default: getStore())
 * @returns {Promise<{processed: number, remaining: number}>}
 */
export async function expireOverdueVaults(options = {}) {
  const store = options.store || await getStore()
  const now = options.now ? new Date(options.now) : new Date()
  const batchSize = typeof options.batchSize === 'number' ? options.batchSize : 100

  return store.expireOverdueVaults({ now, batchSize })
}

/**
 * Clear expired previous key hashes from API key records so the grace window
 * cannot be replayed after it has elapsed. Runs in batches and returns the
 * number of records cleared and the number still pending.
 *
 * @param {Object} [options]
 * @param {Date|string|number} [options.now] Injected clock for testing (default: Date.now())
 * @param {number} [options.batchSize] Max records to process in this run (default: 100)
 * @param {Object} [options.store] Store instance (default: getStore())
 * @returns {Promise<{processed: number, remaining: number}>}
 */
export async function cleanupExpiredPreviousKeys(options = {}) {
  const store = options.store || await getStore()
  const now = options.now ? new Date(options.now) : new Date()
  const batchSize = typeof options.batchSize === 'number' ? options.batchSize : 100

  if (typeof store.cleanupExpiredPreviousKeys !== 'function') {
    return { processed: 0, remaining: 0 }
  }

  return store.cleanupExpiredPreviousKeys(now, batchSize)
}
