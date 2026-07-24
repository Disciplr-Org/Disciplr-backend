import { Router, Request, Response, NextFunction } from 'express'
import { utcNow } from '../utils/timestamps.js'
import { prisma } from '../lib/prisma.js'
import { authenticate } from '../middleware/auth.js'
import { strictRateLimiter } from '../middleware/rateLimiter.js'
import { AbuseMonitor } from '../services/abuse-monitor.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { AppError } from '../middleware/errorHandler.js'

export const privacyRouter = Router()

export const privacyAbuseMonitor = new AbuseMonitor({
  penaltyScoreLimit: 30,
  decayRate: 0.5,
})

privacyRouter.use(strictRateLimiter)

function isOwnerOrAdmin(req: Request, creator: string): boolean {
  return req.user!.userId === creator || req.user!.role === 'ADMIN'
}

function recordEnumerationAttempt(req: Request, weight: number = 5): void {
  privacyAbuseMonitor.record({
    id: req.ip ?? 'unknown',
    type: 'request',
    weight,
    category: { type: 'enumeration', notFoundCount: 1, distinctPathCount: 1, windowMs: 60000 },
  })
}

function notFoundResponse(res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: 'Creator not found' },
  })
}

/**
 * GET /api/privacy/export?creator=<USER_ID>
 * Exports all data related to a specific creator.
 * Only the owning user or an admin may export data.
 */
privacyRouter.get('/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    const creator = req.query.creator as string

    if (!creator) {
      return next(AppError.badRequest('Missing required query parameter: creator'))
    }

    if (!isOwnerOrAdmin(req, creator)) {
      recordEnumerationAttempt(req)
      return notFoundResponse(res)
    }

    try {
        const userData = await prisma.vault.findMany({
            where: { creatorId: creator },
            include: {
                creator: {
                    select: { id: true }
                }
            }
        })

        res.json({
            creator,
            exportDate: utcNow(),
            data: {
                vaults: userData,
            },
        })
    } catch (error: any) {
        return next(AppError.internal(error.message))
    }
})

/**
 * DELETE /api/privacy/account?creator=<USER_ID>
 * Deletes all records associated with a specific creator.
 * Only the owning user or an admin may delete data.
 */
privacyRouter.delete('/account', authenticate, async (req: Request, res: Response, next: NextFunction) => {
    const creator = creatorIdFromQuery(req)

    if (!creator) {
      return next(AppError.badRequest('Missing required query parameter: creator'))
    }

    if (!isOwnerOrAdmin(req, creator)) {
      recordEnumerationAttempt(req, 10)
      return notFoundResponse(res)
    }

    try {
        const deleteResult = await prisma.vault.deleteMany({
            where: { creatorId: creator }
        })

        if (deleteResult.count === 0) {
          return notFoundResponse(res)
        }

        await createAuditLog({
            actor_user_id: req.user!.userId,
            action: 'privacy.account_erasure',
            target_type: 'creator',
            target_id: creator,
            metadata: { admin: req.user!.role === 'ADMIN' },
        })

        res.json({
            message: 'Account data has been deleted.',
            deletedCount: deleteResult.count,
            status: 'success'
        })
    } catch (error: any) {
        return next(AppError.internal(error.message))
    }
})

function creatorIdFromQuery(req: Request): string | undefined {
    return req.query.creator as string
}
