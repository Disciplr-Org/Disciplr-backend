import { describe, expect, it, mock } from 'bun:test'

type FakePrismaClient = {
  tenantId: string
  requestId: string
  tenantRead: (label: string) => Promise<{ tenantId: string; requestId: string; label: string }>
}

const singletonPrisma = {
  tenantId: 'singleton',
  requestId: 'singleton',
} as unknown as FakePrismaClient

mock.module('../lib/prisma.js', () => ({
  prisma: singletonPrisma,
}))

const { getPrisma, prismaStorage } = await import('../lib/prismaScope.js')

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function createTenantClient(tenantId: string, requestId: string): FakePrismaClient {
  return {
    tenantId,
    requestId,
    async tenantRead(label: string) {
      await Promise.resolve()
      await sleep((requestId.charCodeAt(requestId.length - 1) % 5) + 1)
      return { tenantId, requestId, label }
    },
  }
}

async function runScopedRequest(tenantId: string, requestId: string) {
  const scopedClient = createTenantClient(tenantId, requestId)

  return prismaStorage.run({ prisma: scopedClient as any }, async () => {
    expect((getPrisma() as any).tenantId).toBe(tenantId)
    expect((getPrisma() as any).requestId).toBe(requestId)

    await Promise.resolve()
    expect((getPrisma() as any).tenantId).toBe(tenantId)

    const dbResult = await (getPrisma() as any).tenantRead('after-awaited-db-call')
    expect(dbResult).toEqual({ tenantId, requestId, label: 'after-awaited-db-call' })

    await sleep((requestId.length % 7) + 1)
    expect((getPrisma() as any).requestId).toBe(requestId)

    return {
      tenantId: (getPrisma() as any).tenantId,
      requestId: (getPrisma() as any).requestId,
    }
  })
}

describe('prismaScope concurrent request isolation', () => {
  it('keeps many interleaved request scopes bound to their own tenants', async () => {
    const requests = Array.from({ length: 48 }, (_, index) => {
      const tenantId = `tenant-${index % 12}`
      const requestId = `request-${index}`
      return { tenantId, requestId }
    })

    const results = await Promise.all(
      requests.map(({ tenantId, requestId }) => runScopedRequest(tenantId, requestId)),
    )

    expect(results).toHaveLength(requests.length)
    for (const request of requests) {
      expect(results).toContainEqual(request)
    }
    expect(getPrisma()).toBe(singletonPrisma)
  })

  it('restores the outer request scope after a nested transaction-like scope exits', async () => {
    const outerClient = createTenantClient('tenant-outer', 'request-outer')
    const innerClient = createTenantClient('tenant-inner', 'request-inner')

    await prismaStorage.run({ prisma: outerClient as any }, async () => {
      expect((getPrisma() as any).tenantId).toBe('tenant-outer')

      await prismaStorage.run({ prisma: innerClient as any }, async () => {
        await sleep(2)
        expect((getPrisma() as any).tenantId).toBe('tenant-inner')
      })

      await Promise.resolve()
      expect((getPrisma() as any).tenantId).toBe('tenant-outer')
      expect((getPrisma() as any).requestId).toBe('request-outer')
    })

    expect(getPrisma()).toBe(singletonPrisma)
  })

  it('does not leak a failed request scope into sibling requests or the singleton fallback', async () => {
    const failingClient = createTenantClient('tenant-fail', 'request-fail')
    const siblingClient = createTenantClient('tenant-sibling', 'request-sibling')

    const failingRequest = prismaStorage.run({ prisma: failingClient as any }, async () => {
      await sleep(3)
      expect((getPrisma() as any).tenantId).toBe('tenant-fail')
      throw new Error('synthetic scoped request failure')
    })

    const siblingRequest = prismaStorage.run({ prisma: siblingClient as any }, async () => {
      await sleep(6)
      expect((getPrisma() as any).tenantId).toBe('tenant-sibling')
      return (getPrisma() as any).requestId
    })

    await expect(failingRequest).rejects.toThrow('synthetic scoped request failure')
    await expect(siblingRequest).resolves.toBe('request-sibling')
    expect(getPrisma()).toBe(singletonPrisma)
  })
})
