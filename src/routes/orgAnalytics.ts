import { Router, Request, Response, NextFunction } from "express";
import { orgAnalyticsRateLimiter } from "../middleware/rateLimiter.js";
import { authenticate } from "../middleware/auth.js";
import { requireOrgAccess, requireOrgRole } from "../middleware/orgAuth.js";
import db from "../db/index.js";
import { getTeamRollup } from "../services/team.js";
import {
  getOrgAnalytics,
  listOrgVaultsForRiskAnalytics,
} from "../services/orgAnalytics.js";
import { getOrgRiskAnalytics } from "../services/analytics.service.js";
import { getOrgReports } from "../services/analyticsReports.js";
import { resolveS3Config, getExportSignedUrl } from "../services/exportS3.js";
import { parsePaginationParams, paginateArray } from "../utils/pagination.js";
import { getCohortRetention } from "../services/cohortRetention.js";

export const orgAnalyticsRouter = Router();

orgAnalyticsRouter.get(
  "/:orgId/analytics/risk",
  authenticate,
  requireOrgAccess("owner", "admin"),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params;
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : undefined;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : undefined;

    try {
      const vaults = await listOrgVaultsForRiskAnalytics(orgId);
      const result = getOrgRiskAnalytics(orgId, vaults, { startDate, endDate });
      res.json(result);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to generate risk analytics";
      res.status(400).json({ error: message });
    }
  },
);

orgAnalyticsRouter.get(
  "/:orgId/analytics",
  authenticate,
  requireOrgAccess("owner", "admin"),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params;

    try {
      const analytics = await getOrgAnalytics(orgId);
      res.json(analytics);
    } catch {
      res.status(500).json({ error: "Failed to generate org analytics" });
    }
  },
);

orgAnalyticsRouter.get(
  "/:orgId/cohort-retention",
  authenticate,
  requireOrgAccess("owner", "admin"),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const range = req.query.range
        ? parseInt(req.query.range as string, 10)
        : undefined;

      const data = await getCohortRetention(db, range);

      return res.status(200).json({
        success: true,
        orgId: req.params.orgId,
        data,
      });
    } catch (error) {
      next(error);
    }
  },
);

orgAnalyticsRouter.get(
  "/:orgId/teams/rollup",
  authenticate,
  requireOrgRole(["owner", "admin"]),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params;

    try {
      const rollup = await getTeamRollup(orgId);
      res.json(rollup);
    } catch {
      res.status(500).json({ error: "Failed to generate team rollup" });
    }
  },
);

/**
 * GET /api/orgs/:orgId/analytics/reports
 *
 * List all point-in-time analytics reports for the org.  Each entry includes a
 * signed, expiring download URL when S3 is configured, or a local download path
 * otherwise.  Paginated; newest reports appear first.  Access is restricted to
 * owner/admin members of the org (strict per-org isolation).
 */
orgAnalyticsRouter.get(
  "/:orgId/analytics/reports",
  authenticate,
  requireOrgAccess("owner", "admin"),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params;
    const pagination = parsePaginationParams(req);
    const s3Config = resolveS3Config();

    const allReports = await getOrgReports(orgId);
    const paginated = paginateArray(allReports, pagination);

    const items = await Promise.all(
      paginated.data.map(async (r) => {
        let downloadUrl: string | null = null;
        if (r.s3Key && s3Config) {
          try {
            downloadUrl = await getExportSignedUrl(s3Config, r.s3Key);
          } catch {
            // signed URL generation failure is non-fatal; return null
          }
        } else if (r.localBuffer) {
          downloadUrl = `/api/orgs/${orgId}/analytics/reports/${r.id}/download`;
        }

        return {
          id: r.id,
          orgId: r.orgId,
          snapshotAt: r.snapshotAt,
          createdAt: r.createdAt,
          sizeBytes: r.sizeBytes,
          downloadUrl,
        };
      }),
    );

    res.json({ ...paginated, data: items });
  },
);
