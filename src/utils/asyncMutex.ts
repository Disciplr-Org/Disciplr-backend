/**
 * A simple async mutual-exclusion primitive for coordinating in-process
 * async operations.
 *
 * Usage:
 *   const mutex = new AsyncMutex()
 *   const result = await mutex.runExclusive(async () => { ... })
 *
 * Callers are queued in arrival order. The lock is released automatically
 * after the callback resolves or rejects; the next waiter is woken
 * synchronously so no microtask tick is lost.
 */
export class AsyncMutex {
  private locked = false
  private readonly waitQueue: ((value?: unknown) => void)[] = []

  async runExclusive<T>(fn: () => Promise<T> | T, timeoutMs: number = 15000): Promise<T> {
    // Wait until unlocked
    while (this.locked) {
      await new Promise<void>((resolve, reject) => {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;

        const resolveWrapper = () => {
          if (timeoutId) clearTimeout(timeoutId);
          resolve();
        };

        this.waitQueue.push(resolveWrapper);

        if (timeoutMs > 0) {
          timeoutId = setTimeout(() => {
            const index = this.waitQueue.indexOf(resolveWrapper);
            if (index !== -1) {
              this.waitQueue.splice(index, 1);
            }
            reject(new Error(`AsyncMutex wait timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        }
      })
    }
    this.locked = true

    try {
      return await Promise.resolve(fn())
    } finally {
      // Release and wake the next waiter (if any) before the current
      // microtask queue drains so re-entrancy starvation cannot occur.
      this.locked = false
      const next = this.waitQueue.shift()
      if (next) next()
    }
  }

  /** True when the mutex is currently held by a caller. */
  get isLocked(): boolean {
    return this.locked
  }

  /** Number of callers waiting to acquire the lock. */
  get queueLength(): number {
    return this.waitQueue.length
  }
}
