import { Request, Response, NextFunction } from 'express'
import { OrgRole, getOrganization, getMemberRole } from '../models/organizations.js'

export function requireOrgAccess(...allowedRoles: OrgRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthenticated' })
      return
    }

    const { orgId } = req.params
    if (!orgId) {
      res.status(400).json({ error: 'Missing orgId parameter' })
      return
    }

    const org = getOrganization(orgId)
    if (!org) {
      res.status(404).json({ error: 'Organization not found' })
      return
    }

    const role = getMemberRole(orgId, req.user.userId)
    if (!role) {
      res.status(403).json({ error: 'You are not a member of this organization' })
      return
    }

    if (!allowedRoles.includes(role)) {
      res.status(403).json({
        error: `Forbidden: requires role ${allowedRoles.join(' or ')}, got '${role}'`,
      })
      return
    }

    next()
  }
}
