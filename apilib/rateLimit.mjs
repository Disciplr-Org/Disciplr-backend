// Serverless-safe rate limiting backed by Postgres (or in-process Map for memory mode).
import { getStore as defaultGetStore } from './store.mjs'

export const memoryBuckets = new Map()

export function resetMemoryBuckets() {
  memoryBuckets.clear()
}

/**
 * Normalise an IP string for use as a rate-limit key.
 * - Strips ports and enclosing brackets.
 * - Converts IPv4-mapped IPv6 (::ffff:192.0.2.1) to standard IPv4.
 * - Buckets IPv6 addresses by /64 prefix (the first 4 16-bit blocks).
 */
export function normalizeIp(ipStr) {
  if (!ipStr || typeof ipStr !== 'string') return 'unknown'
  let ip = ipStr.trim()

  if (ip.startsWith('[') && ip.includes(']')) {
    ip = ip.slice(1, ip.indexOf(']'))
  } else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) {
    ip = ip.split(':')[0]
  }

  if (ip.toLowerCase().startsWith('::ffff:')) {
    const v4 = ip.slice(7)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4
  }

  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    return ip
  }

  if (ip.includes(':')) {
    if (ip === '::1' || ip === '0:0:0:0:0:0:0:1') {
      return '::1'
    }

    try {
      const parts = ip.split('::')
      const left = parts[0] ? parts[0].split(':') : []
      const right = parts[1] ? parts[1].split(':') : []
      let full
      if (parts.length > 1) {
        const missing = 8 - (left.length + right.length)
        const middle = Array(Math.max(0, missing)).fill('0')
        full = [...left, ...middle, ...right]
      } else {
        full = ip.split(':')
      }
      const first4 = full.slice(0, 4).map((h) => parseInt(h || '0', 16).toString(16))
      return `${first4.join(':')}::/64`
    } catch {
      return ip
    }
  }

  return ip
}

/**
 * Resolve client IP respecting TRUST_PROXY setting.
 * When TRUST_PROXY=1 (or 'true'), trust X-Forwarded-For taking the right-most hop.
 * Otherwise, ignore X-Forwarded-For and use direct socket remoteAddress.
 */
export function getClientIp(req) {
  let ip = ''
  const trustProxy = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true'

  if (trustProxy) {
    const header = req.headers['x-forwarded-for']
    if (header) {
      const hops = String(header)
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean)
      if (hops.length > 0) {
        ip = hops[hops.length - 1]
      }
    }
  }

  if (!ip) {
    ip = req.socket?.remoteAddress || req.connection?.remoteAddress || req.ip || '127.0.0.1'
  }

  return normalizeIp(ip)
}

/**
 * Increment rate limit bucket in PostgreSQL using a single round-trip.
 * Derives the window start from now() on the Postgres server to eliminate clock skew.
 */
export async function incrementPostgres(pool, key, windowSecs) {
  const query = `
    WITH current_window AS (
      SELECT to_timestamp(floor(extract(epoch from now()) / $2) * $2) AS win_start
    )
    INSERT INTO rate_limit_buckets (key, window_start, count)
    SELECT $1, win_start, 1 FROM current_window
    ON CONFLICT (key, window_start)
    DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count,
              GREATEST(1, ceil(extract(epoch from (window_start + ($2 * interval '1 second') - now())))::int) AS ttl,
              floor(extract(epoch from (window_start + ($2 * interval '1 second'))))::int AS reset_epoch;
  `
  const { rows } = await pool.query(query, [key, windowSecs])

  // Opportunistic cleanup of buckets older than 1 day
  if (Math.random() < 0.05) {
    pool.query("DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '1 day'").catch(() => {})
  }

  return {
    count: Number(rows[0].count),
    ttl: Number(rows[0].ttl),
    resetEpoch: Number(rows[0].reset_epoch),
  }
}

/**
 * Increment rate limit bucket in an in-memory Map.
 */
export function incrementMemory(map, key, windowSecs, nowMs = Date.now()) {
  const windowMs = windowSecs * 1000
  const winStart = Math.floor(nowMs / windowMs) * windowMs
  const bucketKey = `${key}:${winStart}`

  let entry = map.get(bucketKey)
  if (!entry) {
    entry = { count: 0, winStart, windowMs }
    map.set(bucketKey, entry)
  }
  entry.count += 1

  const ttl = Math.max(1, Math.ceil((winStart + windowMs - nowMs) / 1000))
  const resetEpoch = Math.floor((winStart + windowMs) / 1000)

  // Opportunistic cleanup of buckets older than 1 day
  if (Math.random() < 0.05) {
    const cutoff = nowMs - 86400000
    for (const [k, v] of map.entries()) {
      if (v.winStart < cutoff) map.delete(k)
    }
  }

  return {
    count: entry.count,
    ttl,
    resetEpoch,
  }
}

export function isExemptRoute(path) {
  if (!path) return false
  const p = path.split('?')[0]
  return (
    p === '/health' ||
    p === '/openapi.json' ||
    p === '/api/health' ||
    p === '/api/openapi.json' ||
    p === '/api/v1/health' ||
    p === '/api/v1/openapi.json' ||
    p.endsWith('/health') ||
    p.endsWith('/openapi.json')
  )
}

/**
 * Express middleware factory for serverless rate limiting.
 */
export function createRateLimiter({ getStore = defaultGetStore } = {}) {
  return async function rateLimiter(req, res, next) {
    if (isExemptRoute(req.path)) {
      return next()
    }

    const clientIp = getClientIp(req)
    const isWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)

    const writeIpMax = parseInt(process.env.RATE_LIMIT_WRITE_IP_MAX || '20', 10)
    const writeIpWindow = parseInt(process.env.RATE_LIMIT_WRITE_IP_WINDOW_SECS || '60', 10)
    const writeAddrMax = parseInt(process.env.RATE_LIMIT_WRITE_ADDR_MAX || '60', 10)
    const writeAddrWindow = parseInt(process.env.RATE_LIMIT_WRITE_ADDR_WINDOW_SECS || '3600', 10)
    const readIpMax = parseInt(process.env.RATE_LIMIT_READ_IP_MAX || '300', 10)
    const readIpWindow = parseInt(process.env.RATE_LIMIT_READ_IP_WINDOW_SECS || '60', 10)

    try {
      let store
      try {
        store = await getStore()
      } catch (err) {
        console.warn(`[rate-limit] Store unavailable (${err.message}); failing open`)
        return next()
      }

      const increment = async (key, windowSecs) => {
        if (store?.kind === 'postgres' && store?.pool) {
          return await incrementPostgres(store.pool, key, windowSecs)
        }
        return incrementMemory(memoryBuckets, key, windowSecs)
      }

      if (isWrite) {
        // 1. IP write limit
        const ipResult = await increment(`write:ip:${clientIp}`, writeIpWindow)
        if (ipResult.count > writeIpMax) {
          res.setHeader('RateLimit-Limit', String(writeIpMax))
          res.setHeader('RateLimit-Remaining', '0')
          res.setHeader('RateLimit-Reset', String(ipResult.ttl))
          res.setHeader('Retry-After', String(ipResult.ttl))
          return res.status(429).json({ error: 'Too many requests' })
        }

        // 2. Address write limit (creator and/or verifier in body)
        const addresses = []
        if (req.body && typeof req.body === 'object') {
          if (typeof req.body.creator === 'string' && req.body.creator.trim()) {
            addresses.push(req.body.creator.trim())
          }
          if (typeof req.body.verifier === 'string' && req.body.verifier.trim()) {
            addresses.push(req.body.verifier.trim())
          }
        }
        const uniqueAddresses = [...new Set(addresses)]

        let exceededAddr = null
        let lowestAddr = null

        for (const addr of uniqueAddresses) {
          const addrResult = await increment(`write:addr:${addr}`, writeAddrWindow)
          if (addrResult.count > writeAddrMax) {
            exceededAddr = { addr, result: addrResult }
            break
          }
          const remaining = Math.max(0, writeAddrMax - addrResult.count)
          if (!lowestAddr || remaining < lowestAddr.remaining) {
            lowestAddr = { limit: writeAddrMax, remaining, ttl: addrResult.ttl }
          }
        }

        if (exceededAddr) {
          res.setHeader('RateLimit-Limit', String(writeAddrMax))
          res.setHeader('RateLimit-Remaining', '0')
          res.setHeader('RateLimit-Reset', String(exceededAddr.result.ttl))
          res.setHeader('Retry-After', String(exceededAddr.result.ttl))
          return res.status(429).json({ error: 'Too many requests' })
        }

        // Pick policy headers (most restrictive remaining count)
        const ipRemaining = Math.max(0, writeIpMax - ipResult.count)
        if (lowestAddr && lowestAddr.remaining < ipRemaining) {
          res.setHeader('RateLimit-Limit', String(lowestAddr.limit))
          res.setHeader('RateLimit-Remaining', String(lowestAddr.remaining))
          res.setHeader('RateLimit-Reset', String(lowestAddr.ttl))
        } else {
          res.setHeader('RateLimit-Limit', String(writeIpMax))
          res.setHeader('RateLimit-Remaining', String(ipRemaining))
          res.setHeader('RateLimit-Reset', String(ipResult.ttl))
        }

        return next()
      } else {
        // Read IP limit
        const ipResult = await increment(`read:ip:${clientIp}`, readIpWindow)
        if (ipResult.count > readIpMax) {
          res.setHeader('RateLimit-Limit', String(readIpMax))
          res.setHeader('RateLimit-Remaining', '0')
          res.setHeader('RateLimit-Reset', String(ipResult.ttl))
          res.setHeader('Retry-After', String(ipResult.ttl))
          return res.status(429).json({ error: 'Too many requests' })
        }

        res.setHeader('RateLimit-Limit', String(readIpMax))
        res.setHeader('RateLimit-Remaining', String(Math.max(0, readIpMax - ipResult.count)))
        res.setHeader('RateLimit-Reset', String(ipResult.ttl))
        return next()
      }
    } catch (err) {
      console.warn(`[rate-limit] Error enforcing rate limit (${err.message}); failing open`)
      return next()
    }
  }
}
