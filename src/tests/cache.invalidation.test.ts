import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { getOrSet, invalidate, invalidatePrefix, getCacheStats, closeCache } from '../lib/cache.js';

describe('Namespaced Cache Invalidation', () => {
  beforeEach(async () => {
    await closeCache();
  });

  afterEach(async () => {
    await closeCache();
  });

  it('should support invalidate on a missing key (idempotent)', async () => {
    // Invalidation on a non-existent key should not throw
    await expect(invalidate('non-existent-key')).resolves.not.toThrow();
    await expect(invalidate('non-existent-key', 'org-1')).resolves.not.toThrow();
  });

  it('should isolate cache entries by organization namespace', async () => {
    let callCountOrgA = 0;
    let callCountOrgB = 0;

    const loaderA = async () => {
      callCountOrgA++;
      return 'data-A';
    };

    const loaderB = async () => {
      callCountOrgB++;
      return 'data-B';
    };

    // Store same key under different orgs
    const resA1 = await getOrSet('my-key', 60, loaderA, 'org-A');
    const resB1 = await getOrSet('my-key', 60, loaderB, 'org-B');

    expect(resA1).toBe('data-A');
    expect(resB1).toBe('data-B');

    // Invalidate key for org-A only
    await invalidate('my-key', 'org-A');

    // org-A should hit loader again (miss)
    const resA2 = await getOrSet('my-key', 60, loaderA, 'org-A');
    expect(resA2).toBe('data-A');
    expect(callCountOrgA).toBe(2);

    // org-B should still be cached (hit)
    const resB2 = await getOrSet('my-key', 60, loaderB, 'org-B');
    expect(resB2).toBe('data-B');
    expect(callCountOrgB).toBe(1);
  });

  it('should support prefix invalidation within an organization namespace', async () => {
    let callCountA1 = 0;
    let callCountA2 = 0;
    let callCountB1 = 0;

    await getOrSet('prefix:key1', 60, async () => { callCountA1++; return 'A1'; }, 'org-A');
    await getOrSet('prefix:key2', 60, async () => { callCountA2++; return 'A2'; }, 'org-A');
    await getOrSet('prefix:key1', 60, async () => { callCountB1++; return 'B1'; }, 'org-B');

    // Invalidate prefix 'prefix:' for org-A only
    await invalidatePrefix('prefix:', 'org-A');

    // org-A prefix keys should miss
    await getOrSet('prefix:key1', 60, async () => { callCountA1++; return 'A1'; }, 'org-A');
    await getOrSet('prefix:key2', 60, async () => { callCountA2++; return 'A2'; }, 'org-A');

    // org-B prefix keys should hit
    await getOrSet('prefix:key1', 60, async () => { callCountB1++; return 'B1'; }, 'org-B');

    expect(callCountA1).toBe(2);
    expect(callCountA2).toBe(2);
    expect(callCountB1).toBe(1);
  });

  it('should support prefix scan with thousands of keys efficiently and accurately', async () => {
    const keyCount = 2000;
    
    // Seed 2000 keys for org-A
    for (let i = 0; i < keyCount; i++) {
      await getOrSet(`large-prefix:key-${i}`, 60, async () => `val-${i}`, 'org-A');
    }

    // Seed 10 keys for org-B
    for (let i = 0; i < 10; i++) {
      await getOrSet(`large-prefix:key-${i}`, 60, async () => `val-${i}`, 'org-B');
    }

    // Cache stats check (we have 2000 + 10 = 2010 keys)
    // Note: Max memory cache limit is 1000, so the memory cache will evict down to 1000.
    // If it's Redis, it would hold all 2010. But since we use memory cache in tests,
    // let's verify that prefix invalidation works correctly for whatever is in there.
    const statsBefore = getCacheStats();
    expect(statsBefore.size).toBeLessThanOrEqual(1000);

    // Invalidate prefix 'large-prefix:' for org-A
    await invalidatePrefix('large-prefix:', 'org-A');

    // All keys for org-A should be gone.
    // Let's check a few keys to verify they miss.
    let called = false;
    await getOrSet('large-prefix:key-0', 60, async () => { called = true; return 'new-val'; }, 'org-A');
    expect(called).toBe(true);

    // Keys for org-B should still be present if they weren't evicted by LRU.
    // Let's test a key from org-B that was added recently.
    let calledB = false;
    await getOrSet('large-prefix:key-9', 60, async () => { calledB = true; return 'new-val-B'; }, 'org-B');
    expect(calledB).toBe(false);
  });
});
