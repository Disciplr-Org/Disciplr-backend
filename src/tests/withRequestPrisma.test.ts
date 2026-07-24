import { describe, it, expect, jest } from '@jest/globals'

// ── Mock the singleton so we can verify scoped binding ───────────────────────
const mockSingleton = { tag: 'mocked-prisma-singleton', id: 'singleton-1' } as any
jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: mockSingleton }))

const { prismaStorage, getPrisma } = await import('../lib/prismaScope.js')
const { withRequestPrisma } = await import('../middleware/withRequestPrisma.js')

describe('withRequestPrisma Middleware', () => {
  describe('Binding and Cleanup on Success Path', () => {
    it('binds the client to AsyncLocalStorage during next() execution', () => {
      const req = {} as any
      const res = {} as any
      let storeInsideNext: any = null

      withRequestPrisma(req, res, () => {
        storeInsideNext = prismaStorage.getStore()
        expect(getPrisma()).toBe(mockSingleton)
      })

      expect(storeInsideNext).toBeDefined()
      expect(storeInsideNext?.prisma).toBe(mockSingleton)
    })

    it('cleans up the scoped client after next() completes (post-request unbinding)', () => {
      const req = {} as any
      const res = {} as any

      expect(prismaStorage.getStore()).toBeUndefined()

      withRequestPrisma(req, res, () => {
        expect(prismaStorage.getStore()).toBeDefined()
      })

      expect(prismaStorage.getStore()).toBeUndefined()
      expect(getPrisma()).toBe(mockSingleton)
    })

    it('invokes next() with no arguments on standard execution', () => {
      const req = {} as any
      const res = {} as any
      const next = jest.fn()

      withRequestPrisma(req, res, next)

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith()
    })
  })

  describe('Cleanup on Error Paths', () => {
    it('ensures scope cleanup when next() receives an error argument', () => {
      const req = {} as any
      const res = {} as any
      const testError = new Error('Database connection failed')
      let storeInsideErrNext: any = null

      const errorHandlerNext = jest.fn((err?: any) => {
        storeInsideErrNext = prismaStorage.getStore()
        expect(err).toBe(testError)
      })

      withRequestPrisma(req, res, () => {
        errorHandlerNext(testError)
      })

      expect(storeInsideErrNext).toBeDefined()
      expect(prismaStorage.getStore()).toBeUndefined()
    })

    it('ensures scope cleanup when downstream handler throws synchronously', () => {
      const req = {} as any
      const res = {} as any
      const syncError = new Error('Synchronous route failure')

      expect(prismaStorage.getStore()).toBeUndefined()

      expect(() => {
        withRequestPrisma(req, res, () => {
          throw syncError
        })
      }).toThrow(syncError)

      expect(prismaStorage.getStore()).toBeUndefined()
    })

    it('ensures scope cleanup when downstream async handler rejects', async () => {
      const req = {} as any
      const res = {} as any
      const asyncError = new Error('Async promise rejection')

      expect(prismaStorage.getStore()).toBeUndefined()

      await expect(
        new Promise<void>((resolve, reject) => {
          withRequestPrisma(req, res, async () => {
            try {
              await Promise.reject(asyncError)
              resolve()
            } catch (err) {
              reject(err)
            }
          })
        }),
      ).rejects.toThrow('Async promise rejection')

      expect(prismaStorage.getStore()).toBeUndefined()
    })
  })

  describe('Cleanup on Early-Abort / Response End Paths', () => {
    it('maintains scope during early response termination and cleans up after handler exit', () => {
      const req = {} as any
      const res = {
        statusCode: 200,
        end: jest.fn(),
        send: jest.fn(),
      } as any

      let storeDuringAbort: any = null
      const downstreamCalled = jest.fn()

      // Middleware execution where request is aborted / finished early
      withRequestPrisma(req, res, () => {
        storeDuringAbort = prismaStorage.getStore()
        res.statusCode = 401
        res.send({ error: 'Unauthorized' })
        // Early return without calling subsequent middleware
      })

      expect(storeDuringAbort).toBeDefined()
      expect(res.send).toHaveBeenCalledWith({ error: 'Unauthorized' })
      expect(downstreamCalled).not.toHaveBeenCalled()
      expect(prismaStorage.getStore()).toBeUndefined()
    })
  })

  describe('Cross-Request Isolation (Interleaved Concurrent Requests)', () => {
    it('isolates request contexts and prevents cross-request bleed across async ticks', async () => {
      const activeContexts: string[] = []

      // Simulate 3 concurrent requests running through withRequestPrisma
      const runRequest = (requestId: string, delayMs: number) => {
        return new Promise<void>(resolve => {
          const req = { id: requestId } as any
          const res = {} as any

          withRequestPrisma(req, res, async () => {
            const currentStore = prismaStorage.getStore()
            expect(currentStore).toBeDefined()
            expect(currentStore?.prisma).toBe(mockSingleton)

            activeContexts.push(`start-${requestId}`)

            // Yield execution / async delay to interleave tasks
            await new Promise(r => setTimeout(r, delayMs))

            // Verify store is still intact and isolated for this specific request context
            expect(prismaStorage.getStore()).toBe(currentStore)
            activeContexts.push(`end-${requestId}`)
            resolve()
          })
        })
      }

      await Promise.all([
        runRequest('req-1', 30),
        runRequest('req-2', 10),
        runRequest('req-3', 20),
      ])

      expect(activeContexts).toHaveLength(6)
      expect(activeContexts).toContain('start-req-1')
      expect(activeContexts).toContain('end-req-1')
      expect(activeContexts).toContain('start-req-2')
      expect(activeContexts).toContain('end-req-2')
      expect(activeContexts).toContain('start-req-3')
      expect(activeContexts).toContain('end-req-3')

      // Outside all requests, store is clean
      expect(prismaStorage.getStore()).toBeUndefined()
    })
  })

  describe('Nested Middleware Order', () => {
    it('handles nested middleware calls maintaining correct scope stack and unbinding', () => {
      const req = {} as any
      const res = {} as any

      expect(prismaStorage.getStore()).toBeUndefined()

      withRequestPrisma(req, res, () => {
        const outerStore = prismaStorage.getStore()
        expect(outerStore).toBeDefined()

        // Inner nested middleware or transaction scope call
        withRequestPrisma(req, res, () => {
          const innerStore = prismaStorage.getStore()
          expect(innerStore).toBeDefined()
          expect(getPrisma()).toBe(mockSingleton)
        })

        // Outer scope restored
        expect(prismaStorage.getStore()).toBe(outerStore)
      })

      expect(prismaStorage.getStore()).toBeUndefined()
    })
  })
})
