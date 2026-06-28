import Redis from 'ioredis';
import { getEnv } from '../config/env.js';

class InMemoryLRUCache {
  private cache = new Map<string, { version: string; data: any; expiresAt: number }>();
  private readonly maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<any | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Refresh LRU order: delete and re-insert
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.data;
  }

  async set(key: string, data: any, expiresAt: number): Promise<void> {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in insertion order)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { version: CACHE_VERSION, data, expiresAt });
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
    // Clean expired entries first before returning size to be accurate
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.expiresAt) {
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

let initialized = false;
let redisClient: Redis | null = null;
let memoryCache: InMemoryLRUCache | null = null;

function getCacheProvider() {
  if (!initialized) {
    try {
      const env = getEnv();
      if (env.REDIS_URL) {
        redisClient = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: 3,
        });
        redisClient.on('error', (err) => {
          console.error('Redis client error:', err);
        });
      } else {
        memoryCache = new InMemoryLRUCache();
      }
    } catch {
      // Fallback if env is not validated/initialized yet (e.g. in test setup)
      memoryCache = new InMemoryLRUCache();
    }
    initialized = true;
  }
  return { redisClient, memoryCache };
}

export async function getOrSet<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  orgId?: string
): Promise<T> {
  const { redisClient, memoryCache } = getCacheProvider();
  const cacheKey = orgId ? `org:${orgId}:${key}` : key;

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

  // Miss: load
  const data = await loader();

  // Save
  const entry = { version: CACHE_VERSION, data };
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

export async function invalidate(key: string, orgId?: string): Promise<void> {
  const { redisClient, memoryCache } = getCacheProvider();
  const cacheKey = orgId ? `org:${orgId}:${key}` : key;
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
  const cachePrefix = orgId ? `org:${orgId}:${prefix}` : prefix;
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
    } catch (error) {
      // Ignore
    }
    redisClient = null;
  }
  if (memoryCache) {
    memoryCache.clear();
    memoryCache = null;
  }
  initialized = false;
}
