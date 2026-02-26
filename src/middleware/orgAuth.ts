import { Request, Response, NextFunction } from 'express'
import { getUserOrganizationRole, getUserTeamRole } from '../services/membership.js'

export function requireOrgRole(requiredRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' })
      return
    }

    const orgId = req.params.orgId || req.body.orgId || req.query.orgId as string

    if (!orgId) {
      res.status(400).json({ error: 'Organization ID is required' })
      return
    }

    const userRole = await getUserOrganizationRole(req.user.userId, orgId)

    if (!userRole || !requiredRoles.includes(userRole)) {
      res.status(403).json({
        error: `Forbidden: requires organization role ${requiredRoles.join(' or ')}`,
      })
      return
    }

    next()
  }
}

export function requireTeamRole(requiredRoles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' })
      return
    }

    const teamId = req.params.teamId || req.body.teamId || req.query.teamId as string

    if (!teamId) {
      res.status(400).json({ error: 'Team ID is required' })
      return
    }

    const userRole = await getUserTeamRole(req.user.userId, teamId)

    if (!userRole || !requiredRoles.includes(userRole)) {
      res.status(403).json({
        error: `Forbidden: requires team role ${requiredRoles.join(' or ')}`,
      })
      return
    }

    next()
  }
}
