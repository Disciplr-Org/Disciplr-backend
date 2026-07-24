import { orgAnalyticsRateLimiter } from '../middleware/rateLimiter.js'
import { Router, Request, Response, NextFunction } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess, requireOrgRole } from '../middleware/orgAuth.js'
import { vaults, Vault } from './vaults.js'
import { getTeamRollup } from '../services/team.js'
import { getOrgReports } from '../services/analyticsReports.js'
import { resolveS3Config, getExportSignedUrl } from '../services/exportS3.js'
import { parsePaginationParams, paginateArray } from '../utils/pagination.js'
import { getCohortRetention } from '../services/cohortRetention.js'
import db from '../db/index.js'

export const orgAnalyticsRouter = Router();

orgAnalyticsRouter.get(
  "/:orgId/analytics",
  authenticate,
  requireOrgAccess("owner", "admin"),
  orgAnalyticsRateLimiter,
  (req: Request, res: Response) => {
    const { orgId } = req.params;
    const orgVaults = vaults.filter((v) => v.orgId === orgId);

    const activeVaults = orgVaults.filter((v) => v.status === "active").length;
    const completedVaults = orgVaults.filter(
      (v) => v.status === "completed",
    ).length;
    const failedVaults = orgVaults.filter((v) => v.status === "failed").length;

    const totalCapital = orgVaults
      .reduce((sum, v) => sum + parseFloat(v.amount || "0"), 0)
      .toString();

    const resolved = completedVaults + failedVaults;
    const successRate = resolved > 0 ? completedVaults / resolved : 0;

    // Team performance: per-creator breakdown
    const creatorMap = new Map<string, Vault[]>();
    for (const v of orgVaults) {
      const list = creatorMap.get(v.creator) ?? [];
      list.push(v);
      creatorMap.set(v.creator, list);
    }

    const teamPerformance = Array.from(creatorMap.entries()).map(
      ([creator, cvaults]) => {
        const completed = cvaults.filter(
          (v) => v.status === "completed",
        ).length;
        const failed = cvaults.filter((v) => v.status === "failed").length;
        const creatorResolved = completed + failed;
        return {
          creator,
          vaultCount: cvaults.length,
          totalAmount: cvaults
            .reduce((s, v) => s + parseFloat(v.amount || "0"), 0)
            .toString(),
          successRate: creatorResolved > 0 ? completed / creatorResolved : 0,
        };
      },
    );

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
    });
  },
);

// Added the brand-new cohort retention endpoint
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

// Main branch team rollup endpoint preserved intact
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
  }
)

/**
 * GET /api/orgs/:orgId/analytics/reports
 *
 * List all point-in-time analytics reports for the org.  Each entry includes a
 * signed, expiring download URL when S3 is configured, or a local download path
 * otherwise.  Paginated; newest reports appear first.  Access is restricted to
 * owner/admin members of the org (strict per-org isolation).
 */
orgAnalyticsRouter.get(
  '/:orgId/analytics/reports',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgAnalyticsRateLimiter,
  async (req: Request, res: Response) => {
    const { orgId } = req.params
    const pagination = parsePaginationParams(req)
    const s3Config = resolveS3Config()

    const allReports = getOrgReports(orgId)
    const paginated = paginateArray(allReports, pagination)

    const items = await Promise.all(
      paginated.data.map(async (r) => {
        let downloadUrl: string | null = null
        if (r.s3Key && s3Config) {
          try {
            downloadUrl = await getExportSignedUrl(s3Config, r.s3Key)
          } catch {
            // signed URL generation failure is non-fatal; return null
          }
        } else if (r.localBuffer) {
          // In non-S3 mode expose a local download path so clients can retrieve it
          downloadUrl = `/api/orgs/${orgId}/analytics/reports/${r.id}/download`
        }

        return {
          id: r.id,
          orgId: r.orgId,
          snapshotAt: r.snapshotAt,
          createdAt: r.createdAt,
          sizeBytes: r.sizeBytes,
          downloadUrl,
        }
      }),
    )

    res.json({ ...paginated, data: items })
  }
)
