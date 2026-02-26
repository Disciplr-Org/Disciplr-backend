import crypto from 'crypto'
import { stringify as csvStringify } from 'csv-stringify/sync'

export type ExportFormat = 'csv' | 'json'
export type ExportScope = 'vaults' | 'transactions' | 'analytics' | 'all'

export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ExportJob {
    id: string
    userId: string
    isAdmin: boolean
    targetUserId?: string   // admin-only: export data for a specific user; omit for all
    scope: ExportScope
    format: ExportFormat
    status: JobStatus
    createdAt: string
    completedAt?: string
    error?: string
    result?: Buffer
    filename?: string
}

/** In-memory store — swap for a DB table / Redis hash in production */
const jobs = new Map<string, ExportJob>()

export function createJob(params: Omit<ExportJob, 'id' | 'status' | 'createdAt'>): ExportJob {
    const job: ExportJob = {
        ...params,
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
    }
    jobs.set(job.id, job)
    return job
}

export function getJob(id: string): ExportJob | undefined {
    return jobs.get(id)
}

/** Simulate data retrieval — replace with real DB queries */
function fetchData(
    scope: ExportScope,
    userId: string | undefined,
    vaultsStore: Array<Record<string, unknown>>,
): Record<string, unknown> {
    const userVaults = userId
        ? vaultsStore.filter((v) => v['creator'] === userId)
        : vaultsStore

    const transactions = userVaults.map((v) => ({
        vaultId: v['id'],
        type: 'deposit',
        amount: v['amount'],
        timestamp: v['createdAt'],
        status: v['status'],
    }))

    const analytics = [
        {
            userId: userId ?? 'all',
            totalVaults: userVaults.length,
            activeVaults: userVaults.filter((v) => v['status'] === 'active').length,
            completedVaults: userVaults.filter((v) => v['status'] === 'completed').length,
            totalAmount: userVaults.reduce((s, v) => s + Number(v['amount'] ?? 0), 0),
            exportedAt: new Date().toISOString(),
        },
    ]

    if (scope === 'vaults') return { vaults: userVaults }
    if (scope === 'transactions') return { transactions }
    if (scope === 'analytics') return { analytics }
    return { vaults: userVaults, transactions, analytics }
}

function serialize(data: Record<string, unknown>, format: ExportFormat): { buffer: Buffer; filename: string } {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

    if (format === 'json') {
        return {
            buffer: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
            filename: `export-${timestamp}.json`,
        }
    }

    // CSV: flatten each top-level array into its own sheet separated by headers
    const parts: string[] = []
    for (const [key, rows] of Object.entries(data)) {
        if (!Array.isArray(rows) || rows.length === 0) continue
        parts.push(`# ${key.toUpperCase()}\n`)
        parts.push(csvStringify(rows, { header: true }))
        parts.push('\n')
    }

    return {
        buffer: Buffer.from(parts.join(''), 'utf8'),
        filename: `export-${timestamp}.csv`,
    }
}

/**
 * Process a job asynchronously.
 * In production, hand this off to a worker process (Bull, BullMQ, etc.).
 */
export async function processJob(
    jobId: string,
    vaultsStore: Array<Record<string, unknown>>,
): Promise<void> {
    const job = jobs.get(jobId)
    if (!job) return

    job.status = 'running'

    // Simulate async work (DB query, large dataset pagination, etc.)
    await new Promise((r) => setTimeout(r, 50))

    try {
        const targetUser = job.isAdmin ? job.targetUserId : job.userId
        const data = fetchData(job.scope, targetUser, vaultsStore)
        const { buffer, filename } = serialize(data, job.format)

        job.result = buffer
        job.filename = filename
        job.status = 'done'
        job.completedAt = new Date().toISOString()
    } catch (err) {
        job.status = 'failed'
        job.error = err instanceof Error ? err.message : String(err)
        job.completedAt = new Date().toISOString()
    }
}