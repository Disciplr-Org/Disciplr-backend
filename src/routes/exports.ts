import { Router, Response } from 'express'
import { authenticate, requireAdmin, signDownloadToken, verifyDownloadToken, AuthenticatedRequest } from '../middleware/auth.js'
import { createJob, getJob, processJob, ExportFormat, ExportScope } from '../services/exportQueue.js'

/**
 * The vaults store is shared with vaults.ts.
 * In a real app both modules query the same DB; here we accept it as a parameter
 * so the router factory stays testable without globals.
 */
export function createExportRouter(
    vaultsStore: Array<Record<string, unknown>>,
): Router {
    const router = Router()

    function parseOptions(req: AuthenticatedRequest): { format: ExportFormat; scope: ExportScope } | null {
        const format = (req.query['format'] ?? 'json') as string
        const scope = (req.query['scope'] ?? 'all') as string

        const validFormats = ['csv', 'json']
        const validScopes = ['vaults', 'transactions', 'analytics', 'all']

        if (!validFormats.includes(format) || !validScopes.includes(scope)) return null

        return { format: format as ExportFormat, scope: scope as ExportScope }
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // POST /api/exports/me  — authenticated user requests their own export
    // ─────────────────────────────────────────────────────────────────────────────
    /**
     * @query format  csv | json  (default: json)
     * @query scope   vaults | transactions | analytics | all  (default: all)
     *
     * Returns { jobId, statusUrl, pollIntervalMs }
     */
    router.post('/me', authenticate, (req: AuthenticatedRequest, res: Response) => {
        const opts = parseOptions(req)
        if (!opts) {
            res.status(400).json({ error: 'Invalid format or scope parameter' })
            return
        }

        const job = createJob({
            userId: req.user!.id,
            isAdmin: false,
            scope: opts.scope,
            format: opts.format,
        })

        // Fire-and-forget background processing
        processJob(job.id, vaultsStore).catch(console.error)

        res.status(202).json({
            jobId: job.id,
            statusUrl: `/api/exports/status/${job.id}`,
            pollIntervalMs: 1000,
        })
    })

    // ─────────────────────────────────────────────────────────────────────────────
    // POST /api/exports/admin  — admin requests export for any / all users
    // ─────────────────────────────────────────────────────────────────────────────
    /**
     * @query format        csv | json  (default: json)
     * @query scope         vaults | transactions | analytics | all  (default: all)
     * @query targetUserId  (optional) limit export to a single user's data
     */
    router.post(
        '/admin',
        authenticate,
        requireAdmin,
        (req: AuthenticatedRequest, res: Response) => {
            const opts = parseOptions(req)
            if (!opts) {
                res.status(400).json({ error: 'Invalid format or scope parameter' })
                return
            }

            const targetUserId =
                typeof req.query['targetUserId'] === 'string'
                    ? req.query['targetUserId']
                    : undefined

            const job = createJob({
                userId: req.user!.id,
                isAdmin: true,
                targetUserId,
                scope: opts.scope,
                format: opts.format,
            })

            processJob(job.id, vaultsStore).catch(console.error)

            res.status(202).json({
                jobId: job.id,
                statusUrl: `/api/exports/status/${job.id}`,
                pollIntervalMs: 1000,
            })
        },
    )

    // ─────────────────────────────────────────────────────────────────────────────
    // GET /api/exports/status/:jobId  — poll job status, get signed download link
    // ─────────────────────────────────────────────────────────────────────────────
    router.get('/status/:jobId', authenticate, (req: AuthenticatedRequest, res: Response) => {
        const job = getJob(req.params['jobId'])

        if (!job) {
            res.status(404).json({ error: 'Job not found' })
            return
        }

        // Users may only check their own jobs; admins may check any
        if (req.user!.role !== 'admin' && job.userId !== req.user!.id) {
            res.status(403).json({ error: 'Access denied' })
            return
        }

        if (job.status !== 'done') {
            res.json({
                jobId: job.id,
                status: job.status,
                ...(job.error ? { error: job.error } : {}),
            })
            return
        }

        // Issue a short-lived signed download token (1 hour)
        const downloadToken = signDownloadToken(job.id, job.userId, 3600)

        res.json({
            jobId: job.id,
            status: 'done',
            completedAt: job.completedAt,
            downloadUrl: `/api/exports/download/${downloadToken}`,
            expiresInSeconds: 3600,
        })
    })

    // ─────────────────────────────────────────────────────────────────────────────
    // GET /api/exports/download/:token  — secure file download (no auth cookie needed)
    // ─────────────────────────────────────────────────────────────────────────────
    router.get('/download/:token', (req, res: Response) => {
        const verified = verifyDownloadToken(req.params['token'])
        if (!verified) {
            res.status(401).json({ error: 'Invalid or expired download token' })
            return
        }

        const job = getJob(verified.jobId)
        if (!job || job.status !== 'done' || !job.result) {
            res.status(404).json({ error: 'Export not ready or not found' })
            return
        }

        const mimeType = job.format === 'csv' ? 'text/csv' : 'application/json'
        res.setHeader('Content-Type', mimeType)
        res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`)
        res.setHeader('Content-Length', job.result.length)
        res.send(job.result)
    })

    return router
}