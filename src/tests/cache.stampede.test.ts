import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { getOrLoad, getOrSet, invalidate, closeCache, getCacheStats } from '../lib/cache.js';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Cache Stampede Protection — getOrLoad', () => {
  beforeEach(async () => {
    await closeCache();
  });

  afterEach(async () => {
    await closeCache();
  });

  it('should return the value on first call (cache miss)', async () => {
    const loader = jest.fn(async () => 'hello');
    const result = await getOrLoad('test:miss', 10, loader);
    expect(result).toBe('hello');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should serve cached value on second call (cache hit)', async () => {
    const loader = jest.fn(async () => 'value');
    await getOrLoad('test:hit', 10, loader);
    const result2 = await getOrLoad('test:hit', 10, loader);
    expect(result2).toBe('value');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it(
    'should coalesce 100 concurrent misses into a single loader call',
    async () => {
      let callCount = 0;
      const loader = async (): Promise<string> => {
        callCount++;
        await wait(50);
        return 'coalesced';
      };

      const promises: Promise<string>[] = [];
      for (let i = 0; i < 100; i++) {
        promises.push(getOrLoad('test:coalesce', 10, loader));
      }

      const results = await Promise.all(promises);
      expect(results.every((r) => r === 'coalesced')).toBe(true);
      expect(callCount).toBe(1);
    },
    15000,
  );

  it(
    'should propagate loader error to all concurrent waiters',
    async () => {
      let callCount = 0;
      const loader = async (): Promise<string> => {
        callCount++;
        await wait(20);
        throw new Error('loader-failure');
      };

      const promises: Promise<string>[] = [];
      for (let i = 0; i < 20; i++) {
        promises.push(getOrLoad('test:error', 10, loader));
      }

      await expect(Promise.all(promises)).rejects.toThrow('loader-failure');
      expect(callCount).toBe(1);
    },
    15000,
  );

  it('should allow subsequent calls to succeed after a loader error', async () => {
    let callCount = 0;
    const loader = async (): Promise<string> => {
      callCount++;
      if (callCount === 1) throw new Error('first-fail');
      return 'ok';
    };

    await expect(getOrLoad('test:retry', 10, loader)).rejects.toThrow('first-fail');

    const result = await getOrLoad('test:retry', 10, loader);
    expect(result).toBe('ok');
    expect(callCount).toBe(2);
  });

  it(
    'should not coalesce different keys',
    async () => {
      const loaderA = jest.fn(async () => {
        await wait(30);
        return 'A';
      });
      const loaderB = jest.fn(async () => {
        await wait(10);
        return 'B';
      });

      const [resA, resB] = await Promise.all([
        getOrLoad('key-A', 10, loaderA),
        getOrLoad('key-B', 10, loaderB),
      ]);

      expect(resA).toBe('A');
      expect(resB).toBe('B');
      expect(loaderA).toHaveBeenCalledTimes(1);
      expect(loaderB).toHaveBeenCalledTimes(1);
    },
    15000,
  );

  it(
    'should serve stale-while-revalidate value after TTL expiry',
    async () => {
      let callCount = 0;
      const loader = jest.fn(async () => {
        callCount++;
        await wait(20);
        return `value-${callCount}`;
      });

      const res1 = await getOrLoad('test:swr', 1, loader, undefined, { swrSeconds: 10 });
      expect(res1).toBe('value-1');
      expect(callCount).toBe(1);

      await wait(1100);

      const res2 = await getOrLoad('test:swr', 1, loader, undefined, { swrSeconds: 10 });
      expect(res2).toBe('value-1');
      expect(callCount).toBe(2);

      await wait(100);

      const res3 = await getOrLoad('test:swr', 1, loader, undefined, { swrSeconds: 10 });
      expect(res3).toBe('value-2');
    },
    15000,
  );

  it(
    'should not trigger duplicate background refreshes for same key',
    async () => {
      let callCount = 0;
      const loader = jest.fn(async () => {
        callCount++;
        await wait(50);
        return `val-${callCount}`;
      });

      await getOrLoad('test:nodup', 1, loader, undefined, { swrSeconds: 10 });
      expect(callCount).toBe(1);

      await wait(1100);

      const [res1, res2] = await Promise.all([
        getOrLoad('test:nodup', 1, loader, undefined, { swrSeconds: 10 }),
        getOrLoad('test:nodup', 1, loader, undefined, { swrSeconds: 10 }),
      ]);

      expect(res1).toBe('val-1');
      expect(res2).toBe('val-1');
      expect(callCount).toBe(2);
    },
    15000,
  );

  it('should support org namespacing', async () => {
    const loaderA = jest.fn(async () => 'orgA-data');
    const loaderB = jest.fn(async () => 'orgB-data');

    const resA = await getOrLoad('my-key', 10, loaderA, 'org-A');
    const resB = await getOrLoad('my-key', 10, loaderB, 'org-B');

    expect(resA).toBe('orgA-data');
    expect(resB).toBe('orgB-data');
    expect(loaderA).toHaveBeenCalledTimes(1);
    expect(loaderB).toHaveBeenCalledTimes(1);

    const resA2 = await getOrLoad('my-key', 10, loaderA, 'org-A');
    expect(resA2).toBe('orgA-data');
    expect(loaderA).toHaveBeenCalledTimes(1);
  });

  it('should interoperate with getOrSet entries', async () => {
    const loader = jest.fn(async () => 'from-getOrSet');

    await getOrSet('interop', 60, loader);
    expect(loader).toHaveBeenCalledTimes(1);

    const result = await getOrLoad('interop', 60, loader);
    expect(result).toBe('from-getOrSet');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it(
    'should expire entry and call loader again after TTL (beyond SWR)',
    async () => {
      const loader = jest.fn(async () => 'fresh');

      await getOrLoad('test:expire', 1, loader, undefined, { swrSeconds: 1 });
      expect(loader).toHaveBeenCalledTimes(1);

      await wait(2100);

      const result = await getOrLoad('test:expire', 1, loader, undefined, { swrSeconds: 1 });
      expect(result).toBe('fresh');
      expect(loader).toHaveBeenCalledTimes(2);
    },
    15000,
  );

  it('should clean up in-flight promise after completion', async () => {
    const loader = jest.fn(async () => 'cleanup');

    await getOrLoad('test:cleanup', 10, loader);
    expect(loader).toHaveBeenCalledTimes(1);

    await getOrLoad('test:cleanup', 10, loader);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('should clean up in-flight promise after error', async () => {
    const failLoader = jest.fn(async () => { throw new Error('fail'); });
    const okLoader = jest.fn(async () => 'recovered');

    await expect(getOrLoad('test:error-cleanup', 10, failLoader)).rejects.toThrow('fail');

    const result = await getOrLoad('test:error-cleanup', 10, okLoader);
    expect(result).toBe('recovered');
    expect(okLoader).toHaveBeenCalledTimes(1);
  });
});
