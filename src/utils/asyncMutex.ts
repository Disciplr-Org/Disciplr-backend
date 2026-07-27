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

  /**
   * Acquire the lock, run `fn` exclusively, then release the lock.
   * Returns the value produced by `fn`, or re-throws if `fn` throws.
   */
  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    // Wait until unlocked
    while (this.locked) {
      await new Promise<void>((resolve) => this.waitQueue.push(resolve as () => void))
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
