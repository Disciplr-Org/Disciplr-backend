import { Request, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from './auth.js'
import {
  getOrganization,
  getMemberRole as lookupMemberRole,
} from '../models/organizations.js'
import type { OrgRole } from '../models/organizations.js'

export type { OrgRole } from '../models/organizations.js'

/** Alias: enforce org-level role access (roles passed as array). */
export const requireOrgRole = (roles: (OrgRole | string)[]) => requireOrgAccess(...roles)

/** Alias: enforce team-level role access (roles passed as array). */
export const requireTeamRole = (roles: (OrgRole | string)[]) => requireOrgAccess(...roles)

/**
 * Middleware factory that enforces organization-level access control.
 * Checks that the org exists, the caller is a member, and their role
 * is among the allowed set.
 */
export function requireOrgAccess(...allowedRoles: (OrgRole | string)[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || (req.query.orgId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    const org = getOrganization(orgId)
    if (!org) {
      res.status(404).json({ error: 'Organization not found' })
      return
    }

    const role = lookupMemberRole(orgId, userId)
    if (!role) {
      res.status(403).json({ error: 'Forbidden: not a member of this organization' })
      return
    }

    if (!allowedRoles.includes(role)) {
      res.status(403).json({ error: `Forbidden: requires role ${allowedRoles.join(' or ')}` })
      return
    }

    next()
  }
}
