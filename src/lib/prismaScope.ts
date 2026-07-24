import { AsyncLocalStorage } from 'node:async_hooks'
import { PrismaClient } from '@prisma/client'
import { prisma as singletonPrisma } from './prisma.js'

export type PrismaScope = { prisma: PrismaClient }

export const prismaStorage = new AsyncLocalStorage<PrismaScope>()

/**
 * Returns the request-scoped Prisma client if one has been bound by
 * withRequestPrisma middleware, otherwise falls back to the global singleton.
 *
 * Use this everywhere instead of importing `prisma` directly so that callers
 * inside an active $transaction context automatically receive the transaction
 * client without any changes at the call site.
 */
export function getPrisma(): PrismaClient {
  return prismaStorage.getStore()?.prisma ?? singletonPrisma
}
