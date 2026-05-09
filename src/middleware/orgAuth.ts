import { Request, Response, NextFunction } from 'express'
import { AuthenticatedRequest } from './auth.js'
import {
  getOrganization,
  getMemberRole as lookupMemberRole,
} from '../models/organizations.js'
import type { OrgRole } from '../models/organizations.js'
import db from '../db/index.js'

export type { OrgRole } from '../models/organizations.js'

/**
 * In-memory org access middleware (used by orgVaults routes).
 * Checks org existence and membership via in-memory store.
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

/**
 * DB-based org role middleware (used by enterprise routes).
 */
export const requireOrgRole = (roles: (OrgRole | string)[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const orgId = req.params.orgId || (req.query.orgId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!orgId || !userId) {
      res.status(401).json({ error: 'Auth/Org info missing' })
      return
    }

    try {
      const membership = await db('org_members').where({ org_id: orgId, user_id: userId }).first()
      if (!membership || !roles.includes(membership.role)) {
        res.status(403).json({ error: `Forbidden: requires organization role ${roles.join(' or ')}` })
        return
      }
      next()
    } catch {
      res.status(403).json({ error: `Forbidden: requires organization role ${roles.join(' or ')}` })
    }
  }
}

/**
 * DB-based team role middleware (used by enterprise routes).
 */
export const requireTeamRole = (roles: (OrgRole | string)[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const teamId = req.params.teamId || (req.query.teamId as string)
    const userId = req.user?.userId || (req.user as any)?.sub

    if (!teamId || !userId) {
      res.status(401).json({ error: 'Auth/Team info missing' })
      return
    }

    try {
      const membership = await db('team_members').where({ team_id: teamId, user_id: userId }).first()
      if (!membership || !roles.includes(membership.role)) {
        res.status(403).json({ error: `Forbidden: requires team role ${roles.join(' or ')}` })
        return
      }
      next()
    } catch {
      res.status(403).json({ error: `Forbidden: requires team role ${roles.join(' or ')}` })
    }
  }
}
