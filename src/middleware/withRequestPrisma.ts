import { RequestHandler } from 'express'
import { prisma } from '../lib/prisma.js'
import { prismaStorage } from '../lib/prismaScope.js'

/**
 * Binds the shared Prisma singleton to AsyncLocalStorage for the duration of
 * a request.  Any service that calls getPrisma() within this request will
 * receive the same client, making it trivial to wrap multiple service calls in
 * a single prisma.$transaction() at the route layer without threading a client
 * argument through every helper.
 */
export const withRequestPrisma: RequestHandler = (_req, _res, next) => {
  prismaStorage.run({ prisma }, next)
}
