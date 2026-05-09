import crypto from 'node:crypto'
import { stringify as csvStringify } from 'csv-stringify/sync'
import type { Knex } from 'knex'
import type { BackgroundJobSystem } from '../jobs/system.js'

export type ExportFormat = 'csv' | 'json'
export type ExportScope = 'vaults' | 'transactions' | 'analytics' | 'all'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export interface ExportJob {
  id: string
  userId: string
  isAdmin: boolean
  targetUserId?: string
  scope: ExportScope
  format: ExportFormat
  status: JobStatus
  createdAt: string
  completedAt?: string
  error?: string
  result?: Buffer
  filename?: string
  attempts: number
  maxAttempts: number
  idempotencyKey?: string
  requestHash: string
}

export interface EnqueueExportJobInput {
  userId: string
  isAdmin: boolean
  targetUserId?: string
  scope: ExportScope
  format: ExportFormat
  idempotencyKey?: string
  maxAttempts?: number
}

interface ExportJobRecord {
  id: string
  requester_user_id: string
  requester_is_admin: boolean
  target_user_id: string | null
  scope: ExportScope
  format: ExportFormat
  status: JobStatus
  created_at: string
  completed_at: string | null
  error: string | null
  result_data: Buffer | null
  filename: string | null
  attempts: number
  max_attempts: number
  idempotency_key: string | null
  request_hash: string
}

interface ExportJobRepository {
  create(job: Omit<ExportJob, 'id' | 'createdAt' | 'status' | 'attempts'>): Promise<ExportJob>
  get(id: string): Promise<ExportJob | undefined>
  update(job: ExportJob): Promise<ExportJob>
  findByIdempotencyKey(userId: string, idempotencyKey: string): Promise<ExportJob | undefined>
  listRecoverable(): Promise<ExportJob[]>
  reset(): Promise<void>
}

class ExportIdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key has already been used for a different export request')
    this.name = 'ExportIdempotencyConflictError'
  }
}

interface ExportSectionSchema {
  columns: Array<{ key: string; header: string }>
}

type ExportData = {
  vaults?: Array<Record<string, unknown>>
  transactions?: Array<Record<string, unknown>>
  analytics?: Array<Record<string, unknown>>
}

const CSV_UTF8_BOM = '\uFEFF'
const RETRYABLE_EXPORT_JOB_STATUSES: JobStatus[] = ['pending', 'running']
const EXPORT_SECTION_ORDER: Array<keyof ExportData> = ['vaults', 'transactions', 'analytics']
const DEFAULT_MAX_ATTEMPTS = 3

const CSV_SCHEMAS: Record<keyof ExportData, ExportSectionSchema> = {
  vaults: {
    columns: [
      { key: 'id', header: 'id' },
      { key: 'creator', header: 'creator' },
      { key: 'amount', header: 'amount' },
      { key: 'status', header: 'status' },
      { key: 'startDate', header: 'startDate' },
      { key: 'endDate', header: 'endDate' },
      { key: 'verifier', header: 'verifier' },
      { key: 'successDestination', header: 'successDestination' },
      { key: 'failureDestination', header: 'failureDestination' },
      { key: 'createdAt', header: 'createdAt' },
    ],
  },
  transactions: {
    columns: [
      { key: 'id', header: 'id' },
      { key: 'userId', header: 'userId' },
      { key: 'vaultId', header: 'vaultId' },
      { key: 'txHash', header: 'txHash' },
      { key: 'type', header: 'type' },
      { key: 'amount', header: 'amount' },
      { key: 'assetCode', header: 'assetCode' },
      { key: 'fromAccount', header: 'fromAccount' },
      { key: 'toAccount', header: 'toAccount' },
      { key: 'memo', header: 'memo' },
      { key: 'stellarLedger', header: 'stellarLedger' },
      { key: 'stellarTimestamp', header: 'stellarTimestamp' },
      { key: 'explorerUrl', header: 'explorerUrl' },
      { key: 'createdAt', header: 'createdAt' },
    ],
  },
  analytics: {
    columns: [
      { key: 'userId', header: 'userId' },
      { key: 'totalVaults', header: 'totalVaults' },
      { key: 'activeVaults', header: 'activeVaults' },
      { key: 'completedVaults', header: 'completedVaults' },
      { key: 'totalAmount', header: 'totalAmount' },
      { key: 'exportedAt', header: 'exportedAt' },
    ],
  },
}

const hashExportRequest = (input: Pick<EnqueueExportJobInput, 'targetUserId' | 'scope' | 'format'>): string => {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      targetUserId: input.targetUserId ?? null,
      scope: input.scope,
      format: input.format,
    }))
    .digest('hex')
}

const sanitizeCsvValue = (value: unknown): string | number => {
  if (value === null || value === undefined) {
    return ''
  }

  if (typeof value === 'number') {
    return value
  }

  const normalized = String(value)
  if (/^[=+\-@\t\r]/.test(normalized)) {
    return `'${normalized}`
  }

  return normalized
}

const toExportJob = (record: ExportJobRecord): ExportJob => ({
  id: record.id,
  userId: record.requester_user_id,
  isAdmin: record.requester_is_admin,
  targetUserId: record.target_user_id ?? undefined,
  scope: record.scope,
  format: record.format,
  status: record.status,
  createdAt: record.created_at,
  completedAt: record.completed_at ?? undefined,
  error: record.error ?? undefined,
  result: record.result_data ?? undefined,
  filename: record.filename ?? undefined,
  attempts: record.attempts,
  maxAttempts: record.max_attempts,
  idempotencyKey: record.idempotency_key ?? undefined,
  requestHash: record.request_hash,
})

const toRecord = (job: ExportJob): ExportJobRecord => ({
  id: job.id,
  requester_user_id: job.userId,
  requester_is_admin: job.isAdmin,
  target_user_id: job.targetUserId ?? null,
  scope: job.scope,
  format: job.format,
  status: job.status,
  created_at: job.createdAt,
  completed_at: job.completedAt ?? null,
  error: job.error ?? null,
  result_data: job.result ?? null,
  filename: job.filename ?? null,
  attempts: job.attempts,
  max_attempts: job.maxAttempts,
  idempotency_key: job.idempotencyKey ?? null,
  request_hash: job.requestHash,
})

const createInMemoryExportJobRepository = (): ExportJobRepository => {
  const jobs = new Map<string, ExportJob>()
  const idempotencyKeys = new Map<string, string>()

  return {
    async create(job) {
      const created: ExportJob = {
        ...job,
        id: crypto.randomUUID(),
        status: 'pending',
        createdAt: new Date().toISOString(),
        attempts: 0,
      }
      jobs.set(created.id, created)
      if (created.idempotencyKey) {
        idempotencyKeys.set(`${created.userId}:${created.idempotencyKey}`, created.id)
      }
      return { ...created, result: created.result ? Buffer.from(created.result) : undefined }
    },
    async get(id) {
      const job = jobs.get(id)
      if (!job) {
        return undefined
      }
      return { ...job, result: job.result ? Buffer.from(job.result) : undefined }
    },
    async update(job) {
      jobs.set(job.id, { ...job, result: job.result ? Buffer.from(job.result) : undefined })
      return { ...job, result: job.result ? Buffer.from(job.result) : undefined }
    },
    async findByIdempotencyKey(userId, idempotencyKey) {
      const jobId = idempotencyKeys.get(`${userId}:${idempotencyKey}`)
      return jobId ? this.get(jobId) : undefined
    },
    async listRecoverable() {
      return Array.from(jobs.values())
        .filter((job) => RETRYABLE_EXPORT_JOB_STATUSES.includes(job.status) && job.attempts < job.maxAttempts)
        .map((job) => ({ ...job, result: job.result ? Buffer.from(job.result) : undefined }))
    },
    async reset() {
      jobs.clear()
      idempotencyKeys.clear()
    },
  }
}

export const createKnexExportJobRepository = (db: Knex): ExportJobRepository => ({
  async create(job) {
    const insertRecord = toRecord({
      ...job,
      id: crypto.randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
      attempts: 0,
    })

    const [created] = await db<ExportJobRecord>('export_jobs')
      .insert(insertRecord)
      .returning('*')

    return toExportJob(created)
  },
  async get(id) {
    const record = await db<ExportJobRecord>('export_jobs').where({ id }).first()
    return record ? toExportJob(record) : undefined
  },
  async update(job) {
    const [updated] = await db<ExportJobRecord>('export_jobs')
      .where({ id: job.id })
      .update(toRecord(job))
      .returning('*')

    return toExportJob(updated)
  },
  async findByIdempotencyKey(userId, idempotencyKey) {
    const record = await db<ExportJobRecord>('export_jobs')
      .where({ requester_user_id: userId, idempotency_key: idempotencyKey })
      .first()

    return record ? toExportJob(record) : undefined
  },
  async listRecoverable() {
    const rows = await db<ExportJobRecord>('export_jobs')
      .whereIn('status', RETRYABLE_EXPORT_JOB_STATUSES)
      .whereRaw('attempts < max_attempts')
      .orderBy('created_at', 'asc')

    return rows.map(toExportJob)
  },
  async reset() {
    await db('export_jobs').delete()
  },
})

let exportJobRepository: ExportJobRepository = createInMemoryExportJobRepository()

export const configureExportJobRepository = (repository: ExportJobRepository): void => {
  exportJobRepository = repository
}

export function createJob(params: Omit<ExportJob, 'id' | 'status' | 'createdAt' | 'attempts'>): Promise<ExportJob> {
  return exportJobRepository.create(params)
}

export function getJob(id: string): Promise<ExportJob | undefined> {
  return exportJobRepository.get(id)
}

export async function resetExportJobs(): Promise<void> {
  await exportJobRepository.reset()
}

const buildExportDataFromVaultStore = (
  scope: ExportScope,
  userId: string | undefined,
  vaultsStore: Array<Record<string, unknown>>,
): ExportData => {
  const userVaults = userId
    ? vaultsStore.filter((vault) => vault.creator === userId || vault.user_id === userId)
    : vaultsStore

  const vaults = userVaults
    .slice()
    .sort((left, right) => String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')))
    .map((vault) => ({
      id: vault.id,
      creator: vault.creator ?? vault.user_id,
      amount: vault.amount,
      status: vault.status,
      startDate: vault.startDate ?? vault.start_date ?? '',
      endDate: vault.endDate ?? vault.end_date ?? '',
      verifier: vault.verifier ?? '',
      successDestination: vault.successDestination ?? vault.success_destination ?? '',
      failureDestination: vault.failureDestination ?? vault.failure_destination ?? '',
      createdAt: vault.createdAt ?? vault.created_at ?? '',
    }))

  const transactions = vaults.map((vault) => ({
    id: `synthetic-${vault.id}`,
    userId: userId ?? 'all',
    vaultId: vault.id,
    txHash: '',
    type: 'deposit',
    amount: vault.amount,
    assetCode: 'XLM',
    fromAccount: '',
    toAccount: '',
    memo: '',
    stellarLedger: '',
    stellarTimestamp: vault.createdAt,
    explorerUrl: '',
    createdAt: vault.createdAt,
  }))

  const analytics = [
    {
      userId: userId ?? 'all',
      totalVaults: vaults.length,
      activeVaults: vaults.filter((vault) => vault.status === 'active').length,
      completedVaults: vaults.filter((vault) => vault.status === 'completed').length,
      totalAmount: vaults.reduce((sum, vault) => sum + Number(vault.amount ?? 0), 0),
      exportedAt: new Date().toISOString(),
    },
  ]

  if (scope === 'vaults') {
    return { vaults }
  }
  if (scope === 'transactions') {
    return { transactions }
  }
  if (scope === 'analytics') {
    return { analytics }
  }

  return { vaults, transactions, analytics }
}

const buildExportDataFromDatabase = async (
  scope: ExportScope,
  userId: string | undefined,
): Promise<ExportData> => {
  const { db } = await import('../db/index.js')

  const vaultQuery = db('vaults')
    .select(
      'id',
      'creator',
      'status',
      'start_date as startDate',
      'end_date as endDate',
      'verifier',
      'success_destination as successDestination',
      'failure_destination as failureDestination',
      'created_at as createdAt',
      db.raw('amount::text as amount'),
    )
    .orderBy('created_at', 'asc')

  if (userId) {
    vaultQuery.where((builder) => {
      builder.where('creator', userId).orWhere('user_id', userId)
    })
  }

  const vaults = await vaultQuery

  const transactionsQuery = db('transactions')
    .select(
      'id',
      'user_id as userId',
      'vault_id as vaultId',
      'tx_hash as txHash',
      'type',
      'asset_code as assetCode',
      'from_account as fromAccount',
      'to_account as toAccount',
      'memo',
      'stellar_ledger as stellarLedger',
      'stellar_timestamp as stellarTimestamp',
      'explorer_url as explorerUrl',
      'created_at as createdAt',
      db.raw('amount::text as amount'),
    )
    .orderBy('created_at', 'asc')

  if (userId) {
    transactionsQuery.where('user_id', userId)
  }

  const transactions = await transactionsQuery

  const analytics = [
    {
      userId: userId ?? 'all',
      totalVaults: vaults.length,
      activeVaults: vaults.filter((vault) => vault.status === 'active').length,
      completedVaults: vaults.filter((vault) => vault.status === 'completed').length,
      totalAmount: vaults.reduce((sum, vault) => sum + Number(vault.amount ?? 0), 0),
      exportedAt: new Date().toISOString(),
    },
  ]

  if (scope === 'vaults') {
    return { vaults }
  }
  if (scope === 'transactions') {
    return { transactions }
  }
  if (scope === 'analytics') {
    return { analytics }
  }

  return { vaults, transactions, analytics }
}

export function serializeExportData(
  data: ExportData,
  format: ExportFormat,
): { buffer: Buffer; filename: string } {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (format === 'json') {
    return {
      buffer: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
      filename: `export-${timestamp}.json`,
    }
  }

  const parts: string[] = []

  for (const sectionName of EXPORT_SECTION_ORDER) {
    const rows = data[sectionName]
    if (!rows) {
      continue
    }

    const schema = CSV_SCHEMAS[sectionName]
    const orderedRows = rows.map((row) =>
      Object.fromEntries(
        schema.columns.map((column) => [column.key, sanitizeCsvValue(row[column.key])]),
      ),
    )

    parts.push(`# ${sectionName.toUpperCase()}\n`)
    parts.push(
      csvStringify(orderedRows, {
        header: true,
        columns: schema.columns,
      }),
    )
    parts.push('\n')
  }

  return {
    buffer: Buffer.from(`${CSV_UTF8_BOM}${parts.join('')}`, 'utf8'),
    filename: `export-${timestamp}.csv`,
  }
}

export const enqueueExportJob = async (
  jobSystem: BackgroundJobSystem,
  input: EnqueueExportJobInput,
): Promise<ExportJob> => {
  const requestHash = hashExportRequest(input)
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS))

  if (input.idempotencyKey) {
    const existing = await exportJobRepository.findByIdempotencyKey(input.userId, input.idempotencyKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ExportIdempotencyConflictError()
      }
      return existing
    }
  }

  const created = await exportJobRepository.create({
    userId: input.userId,
    isAdmin: input.isAdmin,
    targetUserId: input.targetUserId,
    scope: input.scope,
    format: input.format,
    result: undefined,
    filename: undefined,
    completedAt: undefined,
    error: undefined,
    maxAttempts,
    idempotencyKey: input.idempotencyKey,
    requestHash,
  })

  jobSystem.enqueue('export.generate', { exportJobId: created.id }, { maxAttempts })
  return created
}

export async function processJob(
  jobId: string,
  vaultsStore?: Array<Record<string, unknown>>,
  attempt?: number,
): Promise<void> {
  const job = await exportJobRepository.get(jobId)
  if (!job || job.status === 'done') {
    return
  }

  const nextAttempt = attempt ?? job.attempts + 1

  await exportJobRepository.update({
    ...job,
    status: 'running',
    attempts: nextAttempt,
    error: undefined,
    completedAt: undefined,
  })

  try {
    const scopedUserId = job.isAdmin ? job.targetUserId : job.userId
    const data = vaultsStore
      ? buildExportDataFromVaultStore(job.scope, scopedUserId, vaultsStore)
      : await buildExportDataFromDatabase(job.scope, scopedUserId)
    const { buffer, filename } = serializeExportData(data, job.format)

    await exportJobRepository.update({
      ...job,
      status: 'done',
      attempts: nextAttempt,
      completedAt: new Date().toISOString(),
      error: undefined,
      result: buffer,
      filename,
    })

    console.info(
      JSON.stringify({
        level: 'info',
        event: 'exports.job_completed',
        jobId: job.id,
        format: job.format,
        scope: job.scope,
        attempt: nextAttempt,
        bytes: buffer.length,
        completedAt: new Date().toISOString(),
      }),
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const retryable = nextAttempt < job.maxAttempts

    await exportJobRepository.update({
      ...job,
      status: retryable ? 'pending' : 'failed',
      attempts: nextAttempt,
      completedAt: retryable ? undefined : new Date().toISOString(),
      error: message,
      result: undefined,
      filename: undefined,
    })

    console.error(
      JSON.stringify({
        level: 'error',
        event: 'exports.job_failed',
        jobId: job.id,
        format: job.format,
        scope: job.scope,
        attempt: nextAttempt,
        retryable,
        error: message,
      }),
    )

    throw error
  }
}

export const recoverPendingExportJobs = async (jobSystem: BackgroundJobSystem): Promise<number> => {
  const recoverableJobs = await exportJobRepository.listRecoverable()

  for (const job of recoverableJobs) {
    jobSystem.enqueue(
      'export.generate',
      { exportJobId: job.id },
      { maxAttempts: Math.max(1, job.maxAttempts - job.attempts) },
    )
  }

  return recoverableJobs.length
}

export const isExportIdempotencyConflictError = (error: unknown): error is ExportIdempotencyConflictError => {
  return error instanceof ExportIdempotencyConflictError
}
