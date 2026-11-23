import { describe, it, expect, jest, beforeEach } from '@jest/globals'

// ── mock the singleton so we can distinguish it from a scoped client ──────────
const mockSingleton = { tag: 'singleton' } as any
jest.unstable_mockModule('../lib/prisma.js', () => ({ prisma: mockSingleton }))

const { prismaStorage, getPrisma } = await import('../lib/prismaScope.js')
const { withRequestPrisma } = await import('../middleware/withRequestPrisma.js')

// ── reset ALS between tests ───────────────────────────────────────────────────
beforeEach(() => {
  // ALS context is request-bound and exits after each run() – no manual reset needed
})

describe('getPrisma()', () => {
  it('returns the singleton when no scope is active', () => {
    expect(getPrisma()).toBe(mockSingleton)
  })

  it('returns the scoped client when inside prismaStorage.run()', () => {
    const scopedClient = { tag: 'scoped' } as any
    prismaStorage.run({ prisma: scopedClient }, () => {
      expect(getPrisma()).toBe(scopedClient)
    })
  })

  it('falls back to singleton after the ALS run() callback exits', () => {
    const scopedClient = { tag: 'scoped' } as any
    prismaStorage.run({ prisma: scopedClient }, () => {
      // inside scope — intentionally empty
    })
    // scope is gone
    expect(getPrisma()).toBe(mockSingleton)
  })

  it('isolates scopes across concurrent async runs', async () => {
    const clientA = { tag: 'A' } as any
    const clientB = { tag: 'B' } as any
    const results: string[] = []

    await Promise.all([
      new Promise<void>(resolve =>
        prismaStorage.run({ prisma: clientA }, async () => {
          await Promise.resolve() // yield
          results.push((getPrisma() as any).tag)
          resolve()
        }),
      ),
      new Promise<void>(resolve =>
        prismaStorage.run({ prisma: clientB }, async () => {
          await Promise.resolve()
          results.push((getPrisma() as any).tag)
          resolve()
        }),
      ),
    ])

    // Each async context sees its own client – no cross-contamination
    expect(results).toContain('A')
    expect(results).toContain('B')
    expect(results).toHaveLength(2)
  })
})

describe('withRequestPrisma middleware', () => {
  it('calls next() with no arguments (success path)', () => {
    const req = {} as any
    const res = {} as any
    const next = jest.fn()

    withRequestPrisma(req, res, next)
    expect(next).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })

  it('makes the singleton accessible via getPrisma() inside next()', () => {
    const req = {} as any
    const res = {} as any

    withRequestPrisma(req, res, () => {
      expect(getPrisma()).toBe(mockSingleton)
    })
  })

  it('scoped client is no longer accessible outside next()', () => {
    const req = {} as any
    const res = {} as any
    withRequestPrisma(req, res, () => { /* request handled */ })
    // After next() has returned we are outside the ALS context
    expect(getPrisma()).toBe(mockSingleton)
  })
})
