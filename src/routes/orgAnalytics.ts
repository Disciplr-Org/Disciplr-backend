import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { vaults, Vault } from './vaults.js'

export const orgAnalyticsRouter = Router()

orgAnalyticsRouter.get(
  '/:orgId/analytics',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    const orgVaults = vaults.filter((v) => v.orgId === orgId)

    const activeVaults = orgVaults.filter((v) => v.status === 'active').length
    const completedVaults = orgVaults.filter((v) => v.status === 'completed').length
    const failedVaults = orgVaults.filter((v) => v.status === 'failed').length

    const totalCapital = orgVaults
      .reduce((sum, v) => sum + parseFloat(v.amount || '0'), 0)
      .toString()

    const resolved = completedVaults + failedVaults
    const successRate = resolved > 0 ? completedVaults / resolved : 0

    // Team performance: per-creator breakdown
    const creatorMap = new Map<string, Vault[]>()
    for (const v of orgVaults) {
      const list = creatorMap.get(v.creator) ?? []
      list.push(v)
      creatorMap.set(v.creator, list)
    }

    const teamPerformance = Array.from(creatorMap.entries()).map(([creator, cvaults]) => {
      const completed = cvaults.filter((v) => v.status === 'completed').length
      const failed = cvaults.filter((v) => v.status === 'failed').length
      const creatorResolved = completed + failed
      return {
        creator,
        vaultCount: cvaults.length,
        totalAmount: cvaults.reduce((s, v) => s + parseFloat(v.amount || '0'), 0).toString(),
        successRate: creatorResolved > 0 ? completed / creatorResolved : 0,
      }
    })

    res.json({
      orgId,
      analytics: {
        totalCapital,
        successRate,
        activeVaults,
        completedVaults,
        failedVaults,
      },
      teamPerformance,
      generatedAt: new Date().toISOString(),
    })
  }
)
