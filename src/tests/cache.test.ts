import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { getOrSet, invalidate, invalidatePrefix, getCacheStats, closeCache } from '../lib/cache.js';

describe('Cache-aside Library (Memory Fallback)', () => {
  beforeEach(async () => {
    // Reset/clear cache before each test
    await closeCache();
  });

  afterEach(async () => {
    await closeCache();
  });

  it('should call loader on cache miss and return data', async () => {
    let callCount = 0;
    const loader = async () => {
      callCount++;
      return { hello: 'world' };
    };

    const res1 = await getOrSet('test:key', 10, loader);
    expect(res1).toEqual({ hello: 'world' });
    expect(callCount).toBe(1);

    // Second call should hit cache and NOT call loader
    const res2 = await getOrSet('test:key', 10, loader);
    expect(res2).toEqual({ hello: 'world' });
    expect(callCount).toBe(1);
  });

  it('should expire entries after TTL', async () => {
    let callCount = 0;
    const loader = async () => {
      callCount++;
      return 'value';
    };

    // TTL of 1 second
    await getOrSet('test:ttl', 1, loader);
    expect(callCount).toBe(1);

    // Verify cache hit
    await getOrSet('test:ttl', 1, loader);
    expect(callCount).toBe(1);

    // Wait 1.1s
    await new Promise((resolve) => setTimeout(resolve, 1100));

    // Should miss and call loader again
    await getOrSet('test:ttl', 1, loader);
    expect(callCount).toBe(2);
  });

  it('should support manual invalidation', async () => {
    let callCount = 0;
    const loader = async () => {
      callCount++;
      return 'data';
    };

    await getOrSet('test:invalidate', 60, loader);
    expect(callCount).toBe(1);

    await invalidate('test:invalidate');

    // Should miss after invalidation
    await getOrSet('test:invalidate', 60, loader);
    expect(callCount).toBe(2);
  });

  it('should support prefix invalidation', async () => {
    let callCountA = 0;
    let callCountB = 0;
    let callCountC = 0;

    await getOrSet('prefix:keyA', 60, async () => { callCountA++; return 'A'; });
    await getOrSet('prefix:keyB', 60, async () => { callCountB++; return 'B'; });
    await getOrSet('other:keyC', 60, async () => { callCountC++; return 'C'; });

    // Invalidate keys starting with 'prefix:'
    await invalidatePrefix('prefix:');

    // These two should be misses
    await getOrSet('prefix:keyA', 60, async () => { callCountA++; return 'A'; });
    await getOrSet('prefix:keyB', 60, async () => { callCountB++; return 'B'; });
    // This one should be a hit (callCount remains 1)
    await getOrSet('other:keyC', 60, async () => { callCountC++; return 'C'; });

    expect(callCountA).toBe(2);
    expect(callCountB).toBe(2);
    expect(callCountC).toBe(1);
  });

  it('should evict oldest entry when max capacity is reached (LRU behavior)', async () => {
    // Fill up to 1000 items (max limit)
    for (let i = 0; i < 1000; i++) {
      await getOrSet(`key:${i}`, 60, async () => `val:${i}`);
    }

    expect(getCacheStats().size).toBe(1000);

    // Get key:0 to make it most recently used
    await getOrSet('key:0', 60, async () => 'new-val');

    // Add key:1000 which should trigger eviction of the oldest entry (key:1, since key:0 was accessed)
    await getOrSet('key:1000', 60, async () => 'val:1000');

    expect(getCacheStats().size).toBe(1000);

    // key:1 should have been evicted (miss)
    let key1Called = false;
    await getOrSet('key:1', 60, async () => { key1Called = true; return 'val:1'; });
    expect(key1Called).toBe(true);

    // key:0 should still be in cache (hit)
    let key0Called = false;
    await getOrSet('key:0', 60, async () => { key0Called = true; return 'val:0'; });
    expect(key0Called).toBe(false);
  });
});
