import { Router, type Response } from 'express'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  authenticate,
  requireAdmin,
  signDownloadToken,
  verifyDownloadToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js'
import { requireScopes } from '../middleware/apiKeyAuth.js'
import { ApiScope } from '../types/auth.js'
import {
  enqueueExportJob,
  getJob,
  isExportIdempotencyConflictError,
  type ExportFormat,
  type ExportScope,
  ALLOWED_COLUMNS,
} from '../services/exportQueue.js'
import { checkAndIncrementExportQuota } from '../services/exportQuota.js'
import { getEnv } from '../config/index.js'
import { resolveS3Config, getExportSignedUrl } from '../services/exportS3.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { isOrgMember } from '../models/organizations.js'

const resolveOrgId = (req: AuthenticatedRequest): string =>
  (req as any).orgId as string | undefined ?? (req.query.orgId as string | undefined) ?? (req.headers['x-organization-id'] as string | undefined) ?? (req.user as any)?.orgId ?? req.user!.userId

const enforceExportQuota = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<boolean> => {
  const orgId = resolveOrgId(req)
  const result = await checkAndIncrementExportQuota(orgId, getEnv().EXPORT_DAILY_QUOTA_LIMIT)
  if (!result.allowed) {
    res.setHeader('Retry-After', String(result.retryAfter))
    res.status(429).json({
      error: 'Export quota exceeded. Try again tomorrow.',
      retryAfter: result.retryAfter,
    })
    return false
  }
  return true
}

type ParseOptionsResult = {
  format: ExportFormat
  scope: ExportScope
  columns?: Record<string, string[]>
}

const negotiateFormat = (req: AuthenticatedRequest, queryFormat?: string): ExportFormat => {
  const normalizedQueryFormat = queryFormat?.toLowerCase()
  if (normalizedQueryFormat && ['csv', 'json', 'ndjson'].includes(normalizedQueryFormat)) {
    return normalizedQueryFormat as ExportFormat
  }

  const acceptHeader = req.headers.accept
  if (acceptHeader) {
    if (acceptHeader.includes('text/csv')) return 'csv'
    if (acceptHeader.includes('application/x-ndjson')) return 'ndjson'
    if (acceptHeader.includes('application/json')) return 'json'
  }

  return 'json'
}

export function createExportRouter(jobSystem: BackgroundJobSystem): Router {
  const router = Router()

  const parseOptions = (req: AuthenticatedRequest): ParseOptionsResult | null => {
    const format = negotiateFormat(req, req.query.format as string | undefined)
    const scope = (req.query.scope ?? 'all') as string
    const columnsParam = req.query.columns as string | undefined

    const validScopes = ['vaults', 'transactions', 'analytics', 'all']
    if (!validScopes.includes(scope)) {
      return null
    }

    const result: ParseOptionsResult = {
      format,
      scope: scope as ExportScope,
    }

    if (columnsParam) {
      try {
        const parsedColumns: Record<string, string[]> = typeof columnsParam === 'string'
          ? JSON.parse(columnsParam)
          : columnsParam
        result.columns = {}

        for (const [section, cols] of Object.entries(parsedColumns)) {
          const allowed = ALLOWED_COLUMNS[section as keyof typeof ALLOWED_COLUMNS]
          if (!allowed) {
            return null
          }

          if (!Array.isArray(cols) || !cols.every(col => allowed.includes(col))) {
            return null
          }
          result.columns[section as keyof typeof ALLOWED_COLUMNS] = cols
        }
      } catch {
        return null
      }
    }

    return result
  }

  const buildAcceptedResponse = (jobId: string) => ({
    jobId,
    statusUrl: `/api/exports/status/${jobId}`,
    pollIntervalMs: 1000,
  })

  router.post('/me', authenticate, requireScopes(ApiScope.ReadAnalytics, ApiScope.ReadVaults), async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format, scope, or columns parameter' })
      return
    }

    if (!await enforceExportQuota(req, res)) return

    try {
      const job = await enqueueExportJob(jobSystem, {
        userId: req.user!.userId,
        orgId: resolveOrgId(req),
        isAdmin: false,
        scope: options.scope,
        format: options.format,
        columns: options.columns as any,
        idempotencyKey: req.header('idempotency-key') ?? undefined,
      })

      res.status(202).json(buildAcceptedResponse(job.id))
    } catch (error) {
      if (isExportIdempotencyConflictError(error)) {
        res.status(409).json({ error: error.message })
        return
      }

      const message = error instanceof Error ? error.message : 'Failed to enqueue export job'
      res.status(500).json({ error: message })
    }
  })

  router.post('/admin', authenticate, requireAdmin, requireScopes(ApiScope.ReadAnalytics, ApiScope.ReadVaults), async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format, scope, or columns parameter' })
      return
    }

    if (!await enforceExportQuota(req, res)) return

    const targetUserId =
      typeof req.query.targetUserId === 'string' ? req.query.targetUserId : undefined

    try {
      const job = await enqueueExportJob(jobSystem, {
        userId: req.user!.userId,
        orgId: resolveOrgId(req),
        isAdmin: true,
        targetUserId,
        scope: options.scope,
        format: options.format,
        columns: options.columns as any,
        idempotencyKey: req.header('idempotency-key') ?? undefined,
      })

      res.status(202).json(buildAcceptedResponse(job.id))
    } catch (error) {
      if (isExportIdempotencyConflictError(error)) {
        res.status(409).json({ error: error.message })
        return
      }

      const message = error instanceof Error ? error.message : 'Failed to enqueue export job'
      res.status(500).json({ error: message })
    }
  })

  router.get('/status/:jobId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const job = await getJob(req.params.jobId)
    if (!job) {
      res.status(404).json({ error: 'Job not found' })
      return
    }

    if (req.user!.role !== 'ADMIN' && job.userId !== req.user!.userId) {
      res.status(403).json({ error: 'Access denied' })
      return
    }

    if (job.status !== 'done') {
      res.json({
        jobId: job.id,
        status: job.status,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        ...(job.error ? { error: job.error } : {}),
      })
      return
    }

    res.json({
      jobId: job.id,
      status: 'done',
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      completedAt: job.completedAt,
      downloadUrl: `/api/exports/${job.id}/download`,
      expiresInSeconds: 60,
    })
  })

  router.get('/download/:token', async (req, res: Response) => {
    const verified = verifyDownloadToken(req.params.token)
    if (!verified) {
      res.status(401).json({ error: 'Invalid or expired download token' })
      return
    }

    const job = await getJob(verified.jobId)
    if (!job || job.userId !== verified.userId || job.status !== 'done' || !job.result) {
      res.status(404).json({ error: 'Export not ready or not found' })
      return
    }

    const mimeType = job.format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/json; charset=utf-8'

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`)
    res.setHeader('Content-Length', job.result.length)

    console.info(
      JSON.stringify({
        level: 'info',
        event: 'exports.download_served',
        jobId: job.id,
        format: job.format,
        bytes: job.result.length,
        filename: job.filename,
        timestamp: new Date().toISOString(),
      }),
    )

    res.send(job.result)
  })

  router.get('/:id/download', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const job = await getJob(req.params.id)
    if (!job || job.status !== 'done') {
      res.status(404).json({ error: 'Export not ready or not found' })
      return
    }

    const callerOrgId = resolveOrgId(req)
    const jobOrgId = job.orgId ?? job.userId
    const isOwner = (jobOrgId === callerOrgId) || (job.userId === req.user!.userId) || isOrgMember(jobOrgId, req.user!.userId)

    if (!isOwner && req.user!.role !== 'ADMIN') {
      res.status(403).json({ error: 'Forbidden: Cross-organization export download rejected' })
      return
    }

    try {
      await createAuditLog({
        actor_user_id: req.user!.userId,
        organization_id: callerOrgId !== req.user!.userId ? callerOrgId : undefined,
        action: 'export.download',
        target_type: 'export_job',
        target_id: job.id,
        metadata: {
          jobId: job.id,
          format: job.format,
          scope: job.scope,
          storage: job.s3Key ? 's3' : 'local',
        },
      })
    } catch (err) {
      console.warn('Failed to record audit log for export download:', err)
    }

    console.info(
      JSON.stringify({
        level: 'info',
        event: 'exports.download_served',
        jobId: job.id,
        principal: req.user!.userId,
        org: callerOrgId,
        timestamp: new Date().toISOString(),
      }),
    )

    const s3Config = resolveS3Config()
    if (s3Config && job.s3Key) {
      const shortTtlSeconds = Number.parseInt(process.env.EXPORT_SIGNED_URL_SHORT_TTL_S ?? '60', 10)
      const signedUrl = await getExportSignedUrl(s3Config, job.s3Key, shortTtlSeconds)
      if (req.headers.accept?.includes('application/json') || req.query.redirect === 'false') {
        res.json({ downloadUrl: signedUrl, expiresInSeconds: shortTtlSeconds })
        return
      }
      res.redirect(302, signedUrl)
      return
    }

    if (!job.result) {
      res.status(404).json({ error: 'Export result data unavailable' })
      return
    }

    const mimeType = job.format === 'csv'
      ? 'text/csv; charset=utf-8'
      : job.format === 'json'
      ? 'application/json; charset=utf-8'
      : 'application/x-ndjson'

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename ?? 'export'}"`)
    res.setHeader('Content-Length', job.result.length)
    res.send(job.result)
  })

  return router
}
