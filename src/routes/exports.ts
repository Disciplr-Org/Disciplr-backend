import { Router, type Response } from 'express'
import { z } from 'zod'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  authenticate,
  requireAdmin,
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
import {
  EXPORT_BOUNDS,
  exportRequestGate,
  isWithinByteLimit,
  streamExportBuffer,
} from '../services/exportBounds.js'

/**
 * The authenticated principal is the only trusted quota/access-control key.
 * Client-supplied orgId query/header values are deliberately ignored.
 */
const resolveOrgId = (req: AuthenticatedRequest): string => req.user!.userId

const logExportEvent = (event: string, payload: Record<string, unknown>): void => {
  console.info(JSON.stringify({
    level: 'info',
    event,
    ...payload,
    timestamp: new Date().toISOString(),
  }))
}

/**
 * Derive the org identifier used for quota and access-control decisions.
 *
 * SECURITY: orgId MUST come only from the verified JWT payload populated by the
 * `authenticate` middleware. Never read orgId from `req.query`, `req.headers`,
 * or any other client-supplied input — those values are attacker-controlled and
 * carry no membership verification.
 */
const resolveOrgId = (req: AuthenticatedRequest): string =>
  // The current JWTPayload type does not carry an orgId claim, so we always
  // fall back to the authenticated userId as the quota-accounting key.
  // If a future JWT version adds a verified orgId claim, it should be
  // added to JWTPayload and read from req.user.orgId (no cast required).
  req.user!.userId

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
    logExportEvent('exports.quota_rejected', { orgId, retryAfter: result.retryAfter })
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

const JobIdSchema = z.string().min(1).max(255)
const TokenSchema = z.string().min(1).max(2048)
const IdempotencyKeySchema = z.string().min(1).max(255).optional()
const TargetUserIdSchema = z.string().min(1).max(255).optional()

export function createExportRouter(jobSystem: BackgroundJobSystem): Router {
  const router = Router()

  const parseOptions = (req: AuthenticatedRequest): ParseOptionsResult | null => {
    const formatStr = typeof req.query.format === 'string' ? req.query.format : undefined
    const format = negotiateFormat(req, formatStr)
    const scopeStr = typeof req.query.scope === 'string' ? req.query.scope : 'all'

    const validScopes = ['vaults', 'transactions', 'analytics', 'all']
    if (!validScopes.includes(scope)) return null
    const ScopeSchema = z.enum(['vaults', 'transactions', 'analytics', 'all'])
    const scopeParse = ScopeSchema.safeParse(scopeStr)
    if (!scopeParse.success) {
      return null
    }
    const scope = scopeParse.data

    const result: ParseOptionsResult = {
      format,
      scope,
    }

    const columnsParam = req.query.columns
    if (columnsParam) {
      if (!isWithinByteLimit(columnsParam, EXPORT_BOUNDS.MAX_COLUMN_FILTER_BYTES)) return null

      try {
        const parsedColumns: unknown = JSON.parse(columnsParam)
        if (!parsedColumns || typeof parsedColumns !== 'object' || Array.isArray(parsedColumns)) return null

        result.columns = {}
        for (const [section, cols] of Object.entries(parsedColumns as Record<string, unknown>)) {
          const allowed = ALLOWED_COLUMNS[section as keyof typeof ALLOWED_COLUMNS]
          if (!allowed || !Array.isArray(cols) || cols.length > EXPORT_BOUNDS.MAX_COLUMNS_PER_SECTION) return null
          if (!cols.every(col => typeof col === 'string' && allowed.includes(col))) return null
        const parsedColumns: unknown = typeof columnsParam === 'string'
          ? JSON.parse(columnsParam)
          : columnsParam
        
        const ColumnsSchema = z.record(z.array(z.string()))
        const colsParse = ColumnsSchema.safeParse(parsedColumns)
        if (!colsParse.success) {
          return null
        }
        
        result.columns = {}

        for (const [section, cols] of Object.entries(colsParse.data)) {
          const allowed = ALLOWED_COLUMNS[section as keyof typeof ALLOWED_COLUMNS]
          if (!allowed) {
            return null
          }

          if (!cols.every(col => allowed.includes(col))) {
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
    maxPollAttempts: 300,
  })

  const acquireExportRequest = (req: AuthenticatedRequest, res: Response): string | null => {
    const orgId = resolveOrgId(req)
    if (exportRequestGate.tryAcquire(orgId)) return orgId

    res.setHeader('Retry-After', String(EXPORT_BOUNDS.CONCURRENCY_RETRY_AFTER_SECONDS))
    res.status(429).json({
      error: 'Too many export requests in progress. Retry shortly.',
      retryAfter: EXPORT_BOUNDS.CONCURRENCY_RETRY_AFTER_SECONDS,
    })
    logExportEvent('exports.concurrency_rejected', {
      orgId,
      activeRequests: exportRequestGate.active(orgId),
      limit: EXPORT_BOUNDS.MAX_CONCURRENT_REQUESTS_PER_ORG,
    })
    return null
  }

  router.post('/me', authenticate, requireScopes(ApiScope.ReadAnalytics, ApiScope.ReadVaults), async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format, scope, or columns parameter' })
      return
    }

    const orgId = acquireExportRequest(req, res)
    if (!orgId) return
    const startedAt = Date.now()

    try {
      if (!await enforceExportQuota(req, res)) return
    const idemParse = IdempotencyKeySchema.safeParse(req.header('idempotency-key'))
    if (!idemParse.success) {
      res.status(400).json({ error: 'Invalid idempotency-key header' })
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
        idempotencyKey: idemParse.data,
      })

      try {
        const job = await enqueueExportJob(jobSystem, {
          userId: req.user!.userId,
          orgId,
          isAdmin: false,
          scope: options.scope,
          format: options.format,
          columns: options.columns as any,
          idempotencyKey: req.header('idempotency-key') ?? undefined,
        })

        logExportEvent('exports.enqueue_accepted', {
          orgId,
          jobId: job.id,
          format: options.format,
          scope: options.scope,
          latencyMs: Date.now() - startedAt,
        })
        res.status(202).json(buildAcceptedResponse(job.id))
      } catch (error) {
        if (isExportIdempotencyConflictError(error)) {
          res.status(409).json({ error: error.message })
          return
        }
        const message = error instanceof Error ? error.message : 'Failed to enqueue export job'
        logExportEvent('exports.enqueue_failed', {
          orgId,
          latencyMs: Date.now() - startedAt,
          error: message.slice(0, 200),
        })
        res.status(500).json({ error: message })
      }
    } finally {
      exportRequestGate.release(orgId)
    }
  })

  router.post('/admin', authenticate, requireAdmin, requireScopes(ApiScope.ReadAnalytics, ApiScope.ReadVaults), async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format, scope, or columns parameter' })
      return
    }

    const targetUserId = typeof req.query.targetUserId === 'string' ? req.query.targetUserId : undefined
    const orgId = acquireExportRequest(req, res)
    if (!orgId) return
    const startedAt = Date.now()

    try {
      if (!await enforceExportQuota(req, res)) return
    const idemParse = IdempotencyKeySchema.safeParse(req.header('idempotency-key'))
    if (!idemParse.success) {
      res.status(400).json({ error: 'Invalid idempotency-key header' })
      return
    }

    const targetUserParse = TargetUserIdSchema.safeParse(req.query.targetUserId)
    if (!targetUserParse.success) {
      res.status(400).json({ error: 'Invalid targetUserId parameter' })
      return
    }

    if (!await enforceExportQuota(req, res)) return

    const targetUserId = targetUserParse.data

    try {
      const job = await enqueueExportJob(jobSystem, {
        userId: req.user!.userId,
        orgId: resolveOrgId(req),
        isAdmin: true,
        targetUserId,
        scope: options.scope,
        format: options.format,
        columns: options.columns as any,
        idempotencyKey: idemParse.data,
      })

      try {
        const job = await enqueueExportJob(jobSystem, {
          userId: req.user!.userId,
          orgId,
          isAdmin: true,
          targetUserId,
          scope: options.scope,
          format: options.format,
          columns: options.columns as any,
          idempotencyKey: req.header('idempotency-key') ?? undefined,
        })

        logExportEvent('exports.enqueue_accepted', {
          orgId,
          jobId: job.id,
          format: options.format,
          scope: options.scope,
          latencyMs: Date.now() - startedAt,
        })
        res.status(202).json(buildAcceptedResponse(job.id))
      } catch (error) {
        if (isExportIdempotencyConflictError(error)) {
          res.status(409).json({ error: error.message })
          return
        }
        const message = error instanceof Error ? error.message : 'Failed to enqueue export job'
        logExportEvent('exports.enqueue_failed', {
          orgId,
          latencyMs: Date.now() - startedAt,
          error: message.slice(0, 200),
        })
        res.status(500).json({ error: message })
      }
    } finally {
      exportRequestGate.release(orgId)
    }
  })

  router.get('/status/:jobId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const parseResult = JobIdSchema.safeParse(req.params.jobId)
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid jobId parameter' })
      return
    }
    const jobId = parseResult.data

    const job = await getJob(jobId)
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
    const parseResult = TokenSchema.safeParse(req.params.token)
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid token parameter' })
      return
    }
    const token = parseResult.data

    const verified = verifyDownloadToken(token)
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
      : job.format === 'ndjson'
      ? 'application/x-ndjson; charset=utf-8'
      : 'application/json; charset=utf-8'

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Content-Disposition', `attachment; filename=\"${job.filename}\"`)
    res.setHeader('Content-Length', job.result.length)
    logExportEvent('exports.download_served', {
      jobId: job.id,
      format: job.format,
      bytes: job.result.length,
    })
    streamExportBuffer(res, job.result)
  })

  router.get('/:id/download', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const parseResult = JobIdSchema.safeParse(req.params.id)
    if (!parseResult.success) {
      res.status(400).json({ error: 'Invalid id parameter' })
      return
    }
    const id = parseResult.data

    const job = await getJob(id)
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

    logExportEvent('exports.download_requested', {
      jobId: job.id,
      storage: job.s3Key ? 's3' : 'local',
    })

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
    res.setHeader('Content-Disposition', `attachment; filename=\"${job.filename ?? 'export'}\"`)
    res.setHeader('Content-Length', job.result.length)
    streamExportBuffer(res, job.result)
  })

  return router
}
