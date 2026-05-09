import { Router, type Response } from 'express'
import type { BackgroundJobSystem } from '../jobs/system.js'
import {
  authenticate,
  requireAdmin,
  signDownloadToken,
  verifyDownloadToken,
  type AuthenticatedRequest,
} from '../middleware/auth.js'
import {
  enqueueExportJob,
  getJob,
  isExportIdempotencyConflictError,
  type ExportFormat,
  type ExportScope,
} from '../services/exportQueue.js'

export function createExportRouter(jobSystem: BackgroundJobSystem): Router {
  const router = Router()

  const parseOptions = (req: AuthenticatedRequest): { format: ExportFormat; scope: ExportScope } | null => {
    const format = (req.query.format ?? 'json') as string
    const scope = (req.query.scope ?? 'all') as string

    const validFormats = ['csv', 'json']
    const validScopes = ['vaults', 'transactions', 'analytics', 'all']

    if (!validFormats.includes(format) || !validScopes.includes(scope)) {
      return null
    }

    return { format: format as ExportFormat, scope: scope as ExportScope }
  }

  const buildAcceptedResponse = (jobId: string) => ({
    jobId,
    statusUrl: `/api/exports/status/${jobId}`,
    pollIntervalMs: 1000,
  })

  router.post('/me', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format or scope parameter' })
      return
    }

    try {
      const job = await enqueueExportJob(jobSystem, {
        userId: req.user!.userId,
        isAdmin: false,
        scope: options.scope,
        format: options.format,
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

  router.post('/admin', authenticate, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    const options = parseOptions(req)
    if (!options) {
      res.status(400).json({ error: 'Invalid format or scope parameter' })
      return
    }

    const targetUserId =
      typeof req.query.targetUserId === 'string' ? req.query.targetUserId : undefined

    try {
      const job = await enqueueExportJob(jobSystem, {
        userId: req.user!.userId,
        isAdmin: true,
        targetUserId,
        scope: options.scope,
        format: options.format,
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

    const downloadToken = signDownloadToken(job.id, job.userId, 3600)

    res.json({
      jobId: job.id,
      status: 'done',
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      completedAt: job.completedAt,
      downloadUrl: `/api/exports/download/${downloadToken}`,
      expiresInSeconds: 3600,
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

  return router
}
