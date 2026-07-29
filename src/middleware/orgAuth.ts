import { Request, Response, NextFunction } from "express";
import { AuthenticatedRequest, getAuthenticatedUserId } from "./auth.js";
import { AppError } from "./errorHandler.js";
import type { OrgRole } from "../models/organizations.js";
import db from "../db/index.js";

export type { OrgRole } from "../models/organizations.js";

/**
 * DB-backed org access middleware.
 * Checks org existence and membership via the organizations and org_members tables.
 */
export function requireOrgAccess(...allowedRoles: (OrgRole | string)[]) {
  return async (
    req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction,
  ) => {
    const orgId = req.params.orgId || (req.query.orgId as string);
    const userId = getAuthenticatedUserId(req);

    if (!orgId || !userId) {
      next(AppError.unauthorized("Auth/Org info missing"));
      return;
    }

    try {
      const org = await db("organizations").where({ id: orgId }).first();
      if (!org) {
        next(AppError.notFound("Organization not found"));
        return;
      }
      (req as any).orgId = orgId;

      const membership = await db("org_members")
        .where({ org_id: orgId, user_id: userId })
        .first();

      if (!membership) {
        next(
          AppError.forbidden("Forbidden: not a member of this organization"),
        );
        return;
      }

      if (!allowedRoles.includes(membership.role)) {
        next(
          AppError.forbidden(
            `Forbidden: requires role ${allowedRoles.join(" or ")}`,
          ),
        );
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * DB-based org role middleware (used by enterprise routes).
 */
export const requireOrgRole = (roles: (OrgRole | string)[]) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const orgId = req.params.orgId || (req.query.orgId as string);
    const userId = req.user?.userId || (req.user as any)?.sub;

    if (!orgId || !userId) {
      res.status(401).json({ error: "Auth/Org info missing" });
      return;
    }

    try {
      const membership = await db("org_members")
        .where({ org_id: orgId, user_id: userId })
        .first();
      // Missing membership is a normal no-row result (does not throw) → 403.
      if (!membership || !roles.includes(membership.role)) {
        res
          .status(403)
          .json({
            error: `Forbidden: requires organization role ${roles.join(" or ")}`,
          });
        return;
      }
      next();
    } catch (err) {
      // Unexpected DB/infra failures must not look like authorization denials.
      next(err);
    }
  };
};

/**
 * DB-based team role middleware (used by enterprise routes).
 */
export const requireTeamRole = (roles: (OrgRole | string)[]) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ) => {
    const teamId = req.params.teamId || (req.query.teamId as string);
    const userId = req.user?.userId || (req.user as any)?.sub;

    if (!teamId || !userId) {
      res.status(401).json({ error: "Auth/Team info missing" });
      return;
    }

    try {
      const membership = await db("team_members")
        .where({ team_id: teamId, user_id: userId })
        .first();
      // Missing membership is a normal no-row result (does not throw) → 403.
      if (!membership || !roles.includes(membership.role)) {
        res
          .status(403)
          .json({
            error: `Forbidden: requires team role ${roles.join(" or ")}`,
          });
        return;
      }
      next();
    } catch (err) {
      // Unexpected DB/infra failures must not look like authorization denials.
      next(err);
    }
  };
};
