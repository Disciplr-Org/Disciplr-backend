import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import {
    createJob,
    getJob,
    processJob,
    resetExportJobs,
    serializeExportData,
} from '../services/exportQueue.js'

jest.unstable_mockModule('../middleware/auth.js', () => ({
    authenticate: (_req: Request, _res: Response, next: () => void) => next(),
    requireAdmin: (_req: Request, _res: Response, next: () => void) => next(),
    signDownloadToken: jest.fn(),
    verifyDownloadToken: (token: string) => {
        try {
            const { jobId, userId, exp, sig } = JSON.parse(
                Buffer.from(token, 'base64url').toString('utf8'),
            ) as { jobId: string; userId: string; exp: number; sig: string }
            const payload = `${jobId}:${userId}:${exp}`
            const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
            const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex')

            if (Date.now() / 1000 > exp || sig !== expected) {
                return null
            }

            return { jobId, userId }
        } catch {
            return null
        }
    },
}))

const { createExportRouter } = await import('./exports.js')

type MockResponse = {
    status: (statusCode: number) => MockResponse
    json: (body: unknown) => MockResponse
    setHeader: (name: string, value: string | number) => MockResponse
    send: (body: unknown) => MockResponse
    statusCode?: number
    jsonBody?: unknown
    headers: Record<string, string | number>
    sentBody?: unknown
}

const createMockResponse = (): MockResponse => {
    const response: MockResponse = {
        headers: {},
        status(statusCode: number) {
            response.statusCode = statusCode
            return response
        },
        json(body: unknown) {
            response.jsonBody = body
            return response
        },
        setHeader(name: string, value: string | number) {
            response.headers[name] = value
            return response
        },
        send(body: unknown) {
            response.sentBody = body
            return response
        },
    }

    return response
}

const createDownloadToken = (jobId: string, userId: string, ttlSeconds = 3600): string => {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds
    const payload = `${jobId}:${userId}:${exp}`
    const secret = process.env.DOWNLOAD_SECRET ?? 'change-me-in-production'
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex')

    return Buffer.from(JSON.stringify({ jobId, userId, exp, sig })).toString('base64url')
}

const getDownloadHandler = () => {
    const router = createExportRouter([])
    const layer = router.stack.find((entry) => entry.route?.path === '/download/:token')

    if (!layer?.route?.stack[0]?.handle) {
        throw new Error('Download route handler not found')
    }

    return layer.route.stack[0].handle as (req: Request, res: Response) => void
}

describe('Export CSV behavior', () => {
    beforeEach(() => {
        resetExportJobs()
        jest.restoreAllMocks()
    })

    it('serializes CSV exports with a UTF-8 BOM for spreadsheet compatibility', () => {
        const { buffer, filename } = serializeExportData(
            {
                vaults: [
                    {
                        id: 'vault-1',
                        creator: 'user-1',
                        amount: '150.25',
                        status: 'active',
                    },
                ],
            },
            'csv',
        )

        expect(filename.endsWith('.csv')).toBe(true)
        expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
        expect(buffer.toString('utf8')).toContain('# VAULTS')
        expect(buffer.toString('utf8')).toContain('vault-1')
    })

    it('does not prepend a BOM to JSON exports', () => {
        const { buffer, filename } = serializeExportData(
            {
                vaults: [{ id: 'vault-2' }],
            },
            'json',
        )

        expect(filename.endsWith('.json')).toBe(true)
        expect(buffer.subarray(0, 3)).not.toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
        expect(JSON.parse(buffer.toString('utf8'))).toEqual({ vaults: [{ id: 'vault-2' }] })
    })

    it('returns a BOM-only CSV payload when there are no rows to export', () => {
        const { buffer } = serializeExportData({ vaults: [] }, 'csv')

        expect(buffer).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    })

    it('processes CSV jobs with structured logs that omit user identifiers', async () => {
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)
        const job = createJob({
            userId: 'user-3',
            isAdmin: false,
            scope: 'vaults',
            format: 'csv',
        })

        await processJob(job.id, [
            {
                id: 'vault-3',
                creator: 'user-3',
                amount: '99',
                createdAt: '2030-03-01T00:00:00.000Z',
                status: 'active',
            },
        ])

        const completedJob = getJob(job.id)
        expect(completedJob?.status).toBe('done')
        expect(completedJob?.result?.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

        const logEntries = infoSpy.mock.calls.map(([entry]) => String(entry))
        expect(logEntries.some((entry) => entry.includes('"event":"exports.job_completed"'))).toBe(true)
        expect(logEntries.some((entry) => entry.includes('"format":"csv"'))).toBe(true)
        expect(logEntries.some((entry) => entry.includes('user-3'))).toBe(false)
    })

    it('serves CSV downloads with explicit UTF-8 headers', async () => {
        const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)
        const job = createJob({
            userId: 'user-4',
            isAdmin: false,
            scope: 'vaults',
            format: 'csv',
        })

        await processJob(job.id, [
            {
                id: 'vault-4',
                creator: 'user-4',
                amount: '300',
                createdAt: '2030-04-10T00:00:00.000Z',
                status: 'completed',
            },
        ])

        const handler = getDownloadHandler()
        const token = createDownloadToken(job.id, 'user-4', 3600)
        const request = { params: { token } } as unknown as Request
        const response = createMockResponse()

        handler(request, response as unknown as Response)

        expect(response.statusCode).toBeUndefined()
        expect(response.headers['Content-Type']).toBe('text/csv; charset=utf-8')
        expect(String(response.headers['Content-Disposition'])).toContain('.csv"')
        expect(response.headers['Content-Length']).toBe((getJob(job.id)?.result as Buffer).length)
        expect((response.sentBody as Buffer).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))

        const logEntries = infoSpy.mock.calls.map(([entry]) => String(entry))
        expect(logEntries.some((entry) => entry.includes('"event":"exports.download_served"'))).toBe(true)
        expect(logEntries.some((entry) => entry.includes('user-4'))).toBe(false)
    })
})
