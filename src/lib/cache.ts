import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';

interface CacheEntry {
  version: string;
  data: any;
  expiresAt: number;
  swrExpiresAt: number;
}

class InMemoryLRUCache {
  private cache = new Map<string, CacheEntry>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<any | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      if (Date.now() > entry.swrExpiresAt) {
        this.cache.delete(key);
        return null;
      }
      this.cache.delete(key);
      this.cache.set(key, entry);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  async getStale(key: string, swrWindowMs: number): Promise<{ data: any; stale: boolean } | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    const now = Date.now();
    const swrDeadline = entry.swrExpiresAt > entry.expiresAt
      ? entry.swrExpiresAt
      : entry.expiresAt + swrWindowMs;

    if (now > swrDeadline) {
      this.cache.delete(key);
      return null;
    }

    this.cache.delete(key);
    this.cache.set(key, entry);

    return { data: entry.data, stale: now > entry.expiresAt };
  }

  async set(key: string, data: any, expiresAt: number, swrExpiresAt?: number): Promise<void> {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, {
      version: CACHE_VERSION,
      data,
      expiresAt,
      swrExpiresAt: swrExpiresAt ?? expiresAt,
    });
  }

  async invalidate(key: string): Promise<void> {
    this.cache.delete(key);
  }

  async invalidatePrefix(prefix: string): Promise<void> {
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  size(): number {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.swrExpiresAt) {
        this.cache.delete(key);
      }
    }
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

const CACHE_VERSION = 'v1';
const LOCK_PREFIX = 'lock:';
const LOCK_TTL_MS = 10000;
const POLL_INTERVAL_MS = 50;
const POLL_MAX_ATTEMPTS = 60;

let initialized = false;
let redisClient: Redis | null = null;
let memoryCache: InMemoryLRUCache | null = null;

const inFlightPromises = new Map<string, Promise<any>>();
const backgroundRefreshes = new Set<string>();

const DEL_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

function getCacheProvider() {
  if (!initialized) {
    const env = process.env;
    if (env.REDIS_URL) {
      const redisUrl = env.REDIS_URL;
      if (redisUrl.startsWith('redis://') || redisUrl.startsWith('rediss://')) {
        redisClient = new Redis(redisUrl, {
          maxRetriesPerRequest: 3,
        });
        redisClient.on('error', (err) => {
          console.error('Redis client error:', err);
        });
      } else {
        memoryCache = new InMemoryLRUCache();
      }
    } else {
      memoryCache = new InMemoryLRUCache();
    }
    initialized = true;
  }
  return { redisClient, memoryCache };
}

function buildCacheKey(key: string, orgId?: string): string {
  return orgId ? `org:${orgId}:${key}` : key;
}

async function pollForValue<T>(
  rClient: Redis,
  cacheKey: string,
  lockKey: string,
  timeoutMs: number,
): Promise<T | null> {
  const deadline = Date.now() + Math.min(timeoutMs, 5000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const cached = await rClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.version === CACHE_VERSION) {
          return parsed.data as T;
        }
      }
    } catch {}
    const exists = await rClient.exists(lockKey);
    if (!exists) break;
  }
  return null;
}

async function tryAcquireLock(rClient: Redis, lockKey: string, lockValue: string): Promise<boolean> {
  try {
    const result = await rClient.set(lockKey, lockValue, 'PX', LOCK_TTL_MS, 'NX');
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(rClient: Redis, lockKey: string, lockValue: string): Promise<void> {
  try {
    await rClient.eval(DEL_SCRIPT, 1, lockKey, lockValue);
  } catch {}
}

function refreshInMemory(
  cacheKey: string,
  ttlSeconds: number,
  swrSeconds: number,
  loader: () => Promise<any>,
  mc: InMemoryLRUCache,
): void {
  if (backgroundRefreshes.has(cacheKey)) return;
  backgroundRefreshes.add(cacheKey);

  loader()
    .then((data) => {
      const expiresAt = Date.now() + ttlSeconds * 1000;
      const swrExpiresAt = Date.now() + swrSeconds * 1000;
      return mc.set(cacheKey, data, expiresAt, swrExpiresAt);
    })
    .catch(() => {})
    .finally(() => {
      backgroundRefreshes.delete(cacheKey);
    });
}

function refreshRedis(
  cacheKey: string,
  ttlSeconds: number,
  swrSeconds: number,
  loader: () => Promise<any>,
  rClient: Redis,
): void {
  if (backgroundRefreshes.has(cacheKey)) return;
  backgroundRefreshes.add(cacheKey);

  loader()
    .then((data) => {
      const entry = {
        version: CACHE_VERSION,
        data,
        expiresAt: Date.now() + ttlSeconds * 1000,
        swrExpiresAt: Date.now() + swrSeconds * 1000,
      };
      return rClient.set(cacheKey, JSON.stringify(entry), 'EX', ttlSeconds + swrSeconds);
    })
    .catch(() => {})
    .finally(() => {
      backgroundRefreshes.delete(cacheKey);
    });
}

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  orgId?: string,
): Promise<T> {
  const { redisClient, memoryCache } = getCacheProvider();
  const cacheKey = buildCacheKey(key, orgId);

  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.version === CACHE_VERSION) {
          return parsed.data as T;
        }
      }
    } catch (error) {
      console.warn(`Redis get failed for key ${cacheKey}:`, error);
    }
  } else if (memoryCache) {
    const cachedData = await memoryCache.get(cacheKey);
    if (cachedData !== null) {
      return cachedData as T;
    }
  }

  const data = await loader();

  const expiresAt = Date.now() + ttlSeconds * 1000;
  const entry = { version: CACHE_VERSION, data, expiresAt, swrExpiresAt: expiresAt };
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(entry), 'EX', ttlSeconds);
    } catch (error) {
      console.warn(`Redis set failed for key ${cacheKey}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.set(cacheKey, data, Date.now() + ttlSeconds * 1000);
  }

  return data;
}

export async function getOrLoad<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  orgId?: string,
  options?: { swrSeconds?: number },
): Promise<T> {
  const swrSeconds = options?.swrSeconds ?? ttlSeconds * 2;
  const { redisClient, memoryCache } = getCacheProvider();
  const cacheKey = buildCacheKey(key, orgId);

  // 1. Try primary cache (fast path for fresh entries)
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.version === CACHE_VERSION) {
          const now = Date.now();
          if (now <= (parsed.expiresAt ?? Infinity)) {
            return parsed.data as T;
          }
          if (now <= (parsed.swrExpiresAt ?? parsed.expiresAt ?? 0)) {
            refreshRedis(cacheKey, ttlSeconds, swrSeconds, loader, redisClient);
            return parsed.data as T;
          }
        }
      }
    } catch (error) {
      console.warn(`Redis get failed for key ${cacheKey}:`, error);
    }
  } else if (memoryCache) {
    const staleResult = await memoryCache.getStale(cacheKey, swrSeconds * 1000);
    if (staleResult) {
      if (!staleResult.stale) {
        return staleResult.data as T;
      }
      refreshInMemory(cacheKey, ttlSeconds, swrSeconds, loader, memoryCache);
      return staleResult.data as T;
    }
  }

  // 2. Single-flight coalescing: check if another caller is already loading
  const existing = inFlightPromises.get(cacheKey);
  if (existing) {
    return existing as Promise<T>;
  }

  // 3. Redis distributed locking (multi-replica)
  if (redisClient) {
    const lockKey = `${LOCK_PREFIX}${cacheKey}`;
    const lockValue = randomUUID();
    const acquired = await tryAcquireLock(redisClient, lockKey, lockValue);
    if (!acquired) {
      const polled = await pollForValue<T>(redisClient, cacheKey, lockKey, swrSeconds * 1000);
      if (polled !== null) {
        return polled;
      }
    }

    const promise = (async (): Promise<T> => {
      try {
        const data = await loader();
        const expiresAt = Date.now() + ttlSeconds * 1000;
        const swrExpiresAt = Date.now() + swrSeconds * 1000;
        const entry = { version: CACHE_VERSION, data, expiresAt, swrExpiresAt };
        try {
          await redisClient.set(cacheKey, JSON.stringify(entry), 'EX', ttlSeconds + swrSeconds);
        } catch (error) {
          console.warn(`Redis set failed for key ${cacheKey}:`, error);
        }
        return data;
      } finally {
        inFlightPromises.delete(cacheKey);
        await releaseLock(redisClient, lockKey, lockValue);
      }
    })();

    inFlightPromises.set(cacheKey, promise);
    return promise;
  }

  // 4. In-memory: coalesce with in-flight promise map
  const promise = (async (): Promise<T> => {
    try {
      const data = await loader();
      const expiresAt = Date.now() + ttlSeconds * 1000;
      const swrExpiresAt = Date.now() + swrSeconds * 1000;
      await memoryCache!.set(cacheKey, data, expiresAt, swrExpiresAt);
      return data;
    } finally {
      inFlightPromises.delete(cacheKey);
    }
  })();

  inFlightPromises.set(cacheKey, promise);
  return promise;
}

export async function invalidate(key: string, orgId?: string): Promise<void> {
  const { redisClient, memoryCache } = getCacheProvider();
  const cacheKey = buildCacheKey(key, orgId);
  if (redisClient) {
    try {
      await redisClient.unlink(cacheKey);
    } catch (error) {
      console.warn(`Redis unlink failed for key ${cacheKey}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.invalidate(cacheKey);
  }
}

export async function invalidatePrefix(prefix: string, orgId?: string): Promise<void> {
  const { redisClient, memoryCache } = getCacheProvider();
  const cachePrefix = buildCacheKey(prefix, orgId);
  if (redisClient) {
    try {
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redisClient.scan(cursor, 'MATCH', `${cachePrefix}*`, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await redisClient.unlink(...keys);
        }
      } while (cursor !== '0');
    } catch (error) {
      console.warn(`Redis invalidatePrefix failed for prefix ${cachePrefix}:`, error);
    }
  } else if (memoryCache) {
    await memoryCache.invalidatePrefix(cachePrefix);
  }
}

export function getCacheStats(): { size: number; maxSize: number } {
  const { memoryCache } = getCacheProvider();
  if (memoryCache) {
    return { size: memoryCache.size(), maxSize: 1000 };
  }
  return { size: 0, maxSize: 1000 };
}

export async function closeCache(): Promise<void> {
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch {}
    redisClient = null;
  }
  if (memoryCache) {
    memoryCache.clear();
    memoryCache = null;
  }
  inFlightPromises.clear();
  backgroundRefreshes.clear();
  initialized = false;
}
