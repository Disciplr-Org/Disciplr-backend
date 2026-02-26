import { Router } from 'express'
import { vaults, setVaults } from './vaults.js'
import { createValidationMiddleware } from '../middleware/validation/index.js'
import { privacyExportSchema, privacyDeleteAccountSchema } from '../middleware/validation/schemas.js'

export const privacyRouter = Router()

/**
 * GET /api/privacy/export?creator=<USER_ID>
 * Exports all data related to a specific creator.
 */
privacyRouter.get('/export',
  createValidationMiddleware(privacyExportSchema, { source: 'query' }),
  (req, res) => {
    const creator = req.query.creator as string

    const userData = vaults.filter((v) => v.creator === creator)

    res.json({
        creator,
        exportDate: new Date().toISOString(),
        data: {
            vaults: userData,
        },
    })
  }
)

/**
 * DELETE /api/privacy/account?creator=<USER_ID>
 * Deletes all records associated with a specific creator.
 */
privacyRouter.delete('/account',
  createValidationMiddleware(privacyDeleteAccountSchema, { source: 'query' }),
  (req, res) => {
    const creator = req.query.creator as string

    const initialCount = vaults.length
    const newVaults = vaults.filter((v) => v.creator !== creator)

    if (newVaults.length === initialCount) {
        res.status(404).json({ error: 'No data found for this creator' })
        return
    }

    setVaults(newVaults)

    res.json({
        message: `Account data for creator ${creator} has been deleted.`,
        deletedCount: initialCount - newVaults.length,
        status: 'success'
    })
  }
)
