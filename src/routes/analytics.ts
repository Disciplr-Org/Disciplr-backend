import { Router } from 'express'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'

export const analyticsRouter = Router()
import { Router, Request, Response } from 'express'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray } from '../utils/pagination.js'
import { authenticateApiKey } from '../middleware/apiKeyAuth.js'
import { authenticate } from '../middleware/auth.js'
import { utcNow } from '../utils/timestamps.js'

export const analyticsRouter = Router()

analyticsRouter.get('/summary', authenticate, (req, res) => {
    res.status(200).json({
        total_vaults: 10,
        active_vaults: 5,
        completed_vaults: 3,
        failed_vaults: 2,
        total_locked_capital: '5000.0000000',
        active_capital: '2500.0000000',
        success_rate: 60.0,
        last_updated: utcNow(),
    })
})

analyticsRouter.get('/vaults/:id', authenticate, (req, res) => {
    res.status(200).json({
        vault_id: req.params.id,
        status: 'active',
        performance: 'on_track',
    })
})
