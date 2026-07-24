import {
  resetIdempotencyStore,
  setIdempotencyTtlMs,
  getIdempotentResponse,
  saveIdempotentResponse,
  failPendingIdempotentResponse,
} from '../services/idempotency.js';

describe('Idempotency store internals', () => {
  afterEach(() => {
    resetIdempotencyStore();
  });

  test('only one concurrent caller becomes first claim', async () => {
    const key = 'concurrent-key';
    const hash = 'hash123';

    // First caller registers pending and gets null
    const first = await getIdempotentResponse(key, hash);
    expect(first).toBeNull();

    // Second caller should receive the pending promise
    const secondPromise = getIdempotentResponse(key, hash);

    // Resolve the pending request
    const response = { data: 'ok' };
    await saveIdempotentResponse(key, hash, 'id', response);

    // The second caller resolves to the saved response
    const second = await secondPromise;
    expect(second).toEqual(response);
  });

  test('TTL eviction evicts expired entries and allows reuse', async () => {
    // Short TTL for the test
    setIdempotencyTtlMs(10);
    const key = 'ttl-key';
    const hash = 'hash-ttl';

    await saveIdempotentResponse(key, hash, 'id', { val: 1 });
    const stored = await getIdempotentResponse(key, hash);
    expect(stored).toEqual({ val: 1 });

    // Wait longer than TTL so the entry expires
    await new Promise((resolve) => setTimeout(resolve, 20));

    const afterExpiry = await getIdempotentResponse(key, hash);
    expect(afterExpiry).toBeNull(); // treated as a fresh request

    // New response can be saved under the same key
    await saveIdempotentResponse(key, hash, 'id', { val: 2 });
    const newStored = await getIdempotentResponse(key, hash);
    expect(newStored).toEqual({ val: 2 });
  });

  test('failed first attempt does not poison the key', async () => {
    const key = 'fail-key';
    const hash = 'hash-fail';

    const first = await getIdempotentResponse(key, hash);
    expect(first).toBeNull();

    // Simulate a failure for the pending request
    failPendingIdempotentResponse(key, hash, new Error('boom'));

    // The next request should be able to start fresh
    const second = await getIdempotentResponse(key, hash);
    expect(second).toBeNull();
  });
});
