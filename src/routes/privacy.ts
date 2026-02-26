import { Router, Request, Response } from 'express'
import { prisma } from '../lib/prisma.js'

export const privacyRouter = Router()

/**
 * GET /api/privacy/export?creator=<USER_ID>
 * Exports all data related to a specific creator.
 */
privacyRouter.get('/export', async (req: Request, res: Response) => {
    const creator = req.query.creator as string

    if (!creator) {
        res.status(400).json({ error: 'Missing required query parameter: creator' })
        return
    }

    try {
        const userData = await prisma.vault.findMany({
            where: { creatorId: creator },
            include: {
                creator: {
                    select: { id: true, email: true }
                }
            }
        })

        res.json({
            creator,
            exportDate: new Date().toISOString(),
            data: {
                vaults: userData,
            },
        })
    } catch (error: any) {
        res.status(500).json({ error: error.message })
    }
})

/**
 * DELETE /api/privacy/account?creator=<USER_ID>
 * Deletes all records associated with a specific creator.
 */
privacyRouter.delete('/account', async (req: Request, res: Response) => {
    const creator = creatorIdFromQuery(req)

    if (!creator) {
        res.status(400).json({ error: 'Missing required query parameter: creator' })
        return
    }

    try {
        const deleteResult = await prisma.vault.deleteMany({
            where: { creatorId: creator }
        })

        if (deleteResult.count === 0) {
            res.status(404).json({ error: 'No data found for this creator' })
            return
        }

        res.json({
            message: `Account data for creator ${creator} has been deleted.`,
            deletedCount: deleteResult.count,
            status: 'success'
        })
    } catch (error: any) {
        res.status(500).json({ error: error.message })
    }
})

function creatorIdFromQuery(req: Request): string | undefined {
    return req.query.creator as string
}
