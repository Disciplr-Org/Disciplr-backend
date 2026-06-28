import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { stringify as csvStringify } from 'csv-stringify/sync'
import type { Knex } from 'knex'
import type { BackgroundJobSystem } from '../jobs/system.js'
import { Readable, Transform } from 'node:stream'
import { createGzip, gzipSync } from 'node:zlib'
import { maskPii, sanitizePrivacyPayload, sanitizePrivacyString } from '../utils/privacy.js'
import { resolveS3Config, uploadToS3 } from '../services/exportS3.js'

export type ExportFormat = 'csv' | 'json' | 'ndjson'
export type ExportScope = 'vaults' | 'transactions' | 'analytics' | 'all'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

export type FailureReason = 'serialization_error' | 'data_fetch_error' | 'unknown_error'

export interface DlqEntry {
  jobId: string
  jobType: string
  failureReason: FailureReason
  errorMessage: string
  attemptCount: number
  failedAt: string
  sanitisedContext: Record<string, unknown>
}

export interface DlqMetricsEvent {
  event: 'entry_added' | 'entry_requeued' | 'entry_discarded' | 'dlq_cleared'
  jobId: string
  failureReason?: FailureReason
  dlqDepth: number
  timestamp: string
}

export type DlqMetricsHook = (event: DlqMetricsEvent) => void

export interface ExportJob {
  id: string
  userId: string
  orgId?: string
  isAdmin: boolean
  targetUserId?: string
  scope: ExportScope
  format: ExportFormat
  columns?: Record<keyof ExportData, string[]>
  status: JobStatus
  createdAt: string
  completedAt?: string
  error?: string
  result?: Buffer
  filename?: string
  s3Key?: string
  attempts: number
  maxAttempts: number
  idempotencyKey?: string
  requestHash: string
}

export interface EnqueueExportJobInput {
  userId: string
  orgId?: string
  isAdmin: boolean
  targetUserId?: string
  scope: ExportScope
  format: ExportFormat
  columns?: Record<keyof ExportData, string[]>
  idempotencyKey?: string
  maxAttempts?: number
}

interface ExportJobRecord {
  id: string
  requester_user_id: string
  org_id?: string | null
  requester_is_admin: boolean
  target_user_id: string | null
  scope: ExportScope
  format: ExportFormat
  columns: string | null
  status: JobStatus
  created_at: string
  completed_at: string | null
  error: string | null
  result_data: Buffer | null
  filename: string | null
  s3_key: string | null
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

export const CSV_SCHEMAS: Record<keyof ExportData, ExportSectionSchema> = {
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

export const ALLOWED_COLUMNS: Record<keyof ExportData, string[]> = {
  vaults: CSV_SCHEMAS.vaults.columns.map(c => c.key),
  transactions: CSV_SCHEMAS.transactions.columns.map(c => c.key),
  analytics: CSV_SCHEMAS.analytics.columns.map(c => c.key),
}

const hashExportRequest = (input: Pick<EnqueueExportJobInput, 'targetUserId' | 'scope' | 'format' | 'columns'>): string => {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      targetUserId: input.targetUserId ?? null,
      scope: input.scope,
      format: input.format,
      columns: input.columns ?? null,
    }))
    .digest('hex')
}

const exportPiiValues = (job: Pick<ExportJob, 'userId' | 'targetUserId'>): string[] =>
  [job.userId, job.targetUserId].filter((value): value is string => typeof value === 'string' && value.length > 0)

const exportUserTokens = (job: Pick<ExportJob, 'userId' | 'targetUserId'>): {
  requesterUserToken: string
  targetUserToken?: string
} => ({
  requesterUserToken: maskPii(job.userId),
  ...(job.targetUserId ? { targetUserToken: maskPii(job.targetUserId) } : {}),
})

const sanitizeExportTelemetry = (
  payload: Record<string, unknown>,
  job: Pick<ExportJob, 'userId' | 'targetUserId'>,
): Record<string, unknown> => sanitizePrivacyPayload(
  {
    ...payload,
    ...exportUserTokens(job),
  },
  exportPiiValues(job),
) as Record<string, unknown>

const toExportJob = (record: ExportJobRecord): ExportJob => ({
  id: record.id,
  userId: record.requester_user_id,
  orgId: record.org_id ?? undefined,
  isAdmin: record.requester_is_admin,
  targetUserId: record.target_user_id ?? undefined,
  scope: record.scope,
  format: record.format,
  columns: record.columns ? JSON.parse(record.columns) : undefined,
  status: record.status,
  createdAt: record.created_at,
  completedAt: record.completed_at ?? undefined,
  error: record.error ?? undefined,
  result: record.result_data ?? undefined,
  filename: record.filename ?? undefined,
  s3Key: record.s3_key ?? undefined,
  attempts: record.attempts,
  maxAttempts: record.max_attempts,
  idempotencyKey: record.idempotency_key ?? undefined,
  requestHash: record.request_hash,
})

const toRecord = (job: ExportJob): ExportJobRecord => ({
  id: job.id,
  requester_user_id: job.userId,
  org_id: job.orgId ?? null,
  requester_is_admin: job.isAdmin,
  target_user_id: job.targetUserId ?? null,
  scope: job.scope,
  format: job.format,
  columns: job.columns ? JSON.stringify(job.columns) : null,
  status: job.status,
  created_at: job.createdAt,
  completed_at: job.completedAt ?? null,
  error: job.error ?? null,
  result_data: job.result ?? null,
  filename: job.filename ?? null,
  s3_key: job.s3Key ?? null,
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

const DEFAULT_MAX_DLQ_SIZE = 100

let dlqStore: DlqEntry[] = []
let dlqMaxSize = DEFAULT_MAX_DLQ_SIZE
let dlqMetricsHook: DlqMetricsHook | undefined

export const configureDlq = (options?: { maxSize?: number; metricsHook?: DlqMetricsHook }): void => {
  if (options?.maxSize !== undefined) {
    dlqMaxSize = Math.max(1, Math.floor(options.maxSize))
  }
  dlqMetricsHook = options?.metricsHook
}

const sanitiseDlqContext = (job: ExportJob): Record<string, unknown> => {
  return sanitizePrivacyPayload(
    { ...exportUserTokens(job), scope: job.scope, format: job.format, isAdmin: job.isAdmin, requestHash: job.requestHash },
    exportPiiValues(job),
  ) as Record<string, unknown>
}

const dlqInsert = (entry: DlqEntry): void => {
  while (dlqStore.length >= dlqMaxSize) {
    dlqStore.shift()
  }
  dlqStore.push(entry)
}

const dlqRemove = (jobId: string): DlqEntry | undefined => {
  const index = dlqStore.findIndex(e => e.jobId === jobId)
  if (index === -1) return undefined
  const [entry] = dlqStore.splice(index, 1)
  return entry
}

const safeInvokeMetricsHook = (event: DlqMetricsEvent): void => {
  if (!dlqMetricsHook) return
  try {
    dlqMetricsHook(event)
  } catch {
    console.warn(JSON.stringify({ level: 'warn', event: 'dlq.metrics_hook_failed', timestamp: new Date().toISOString() }))
  }
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

export const getDlqEntries = (): readonly DlqEntry[] => {
  const copy = [...dlqStore]
  copy.reverse()
  return copy
}

export const getDlqEntry = (jobId: string): DlqEntry | undefined =>
  dlqStore.find(e => e.jobId === jobId)

export const getDlqDepth = (): number => dlqStore.length

export const requeueDlqEntry = async (jobId: string): Promise<boolean> => {
  const entry = dlqRemove(jobId)
  if (!entry) return false

  const job = await exportJobRepository.get(jobId)
  if (!job) return false

  await exportJobRepository.update({
    ...job,
    status: 'pending',
    attempts: 0,
    error: undefined,
    completedAt: undefined,
  })

  safeInvokeMetricsHook({
    event: 'entry_requeued',
    jobId,
    dlqDepth: dlqStore.length,
    timestamp: new Date().toISOString(),
  })

  return true
}

export const discardDlqEntry = (jobId: string): boolean => {
  const entry = dlqRemove(jobId)
  if (!entry) return false

  safeInvokeMetricsHook({
    event: 'entry_discarded',
    jobId,
    dlqDepth: dlqStore.length,
    timestamp: new Date().toISOString(),
  })

  return true
}

export const clearDlq = (): number => {
  const count = dlqStore.length
  dlqStore = []

  safeInvokeMetricsHook({
    event: 'dlq_cleared',
    jobId: '',
    dlqDepth: 0,
    timestamp: new Date().toISOString(),
  })

  return count
}

export const resetDlq = (): void => {
  dlqStore = []
  dlqMaxSize = DEFAULT_MAX_DLQ_SIZE
  dlqMetricsHook = undefined
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

function ndjsonGzipReadable(data: ExportData): Readable {
  const generator = async function* () {
    for (const sectionName of EXPORT_SECTION_ORDER) {
      const rows = data[sectionName]
      if (!rows) continue
      for (const row of rows) {
        yield JSON.stringify(row) + '\n'
      }
    }
  }
  const source = Readable.from(generator())
  return source.pipe(createGzip())
}

function filterExportData(
  data: ExportData,
  columns?: Record<keyof ExportData, string[]>,
): ExportData {
  const result: ExportData = {}

  for (const sectionName of EXPORT_SECTION_ORDER) {
    const rows = data[sectionName]
    if (!rows) continue

    const allowedColumns = columns?.[sectionName]
    if (!allowedColumns) {
      result[sectionName] = rows
      continue
    }

    result[sectionName] = rows.map(row => {
      const filteredRow: Record<string, unknown> = {}
      for (const col of allowedColumns) {
        if (col in row) {
          filteredRow[col] = row[col]
        }
      }
      return filteredRow
    })
  }

  return result
}

function filterCsvSchema(
  schema: ExportSectionSchema,
  allowedColumns?: string[],
): ExportSectionSchema {
  if (!allowedColumns) return schema
  return {
    columns: schema.columns.filter(col => allowedColumns.includes(col.key)),
  }
}

export function serializeExportData(
  data: ExportData,
  format: ExportFormat,
  columns?: Record<keyof ExportData, string[]>,
): { buffer?: Buffer; filename: string; readable?: Readable } {
  const filteredData = filterExportData(data, columns)
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')

  if (format === 'json') {
    return {
      buffer: Buffer.from(JSON.stringify(filteredData, null, 2), 'utf8'),
      filename: `export-${timestamp}.json`,
    }
  }

  if (format === 'ndjson') {
    const filename = `export-${timestamp}.ndjson.gz`
    const readable = ndjsonGzipReadable(filteredData)
    return { filename, readable }
  }

  const parts: string[] = [CSV_UTF8_BOM]

  for (const sectionName of EXPORT_SECTION_ORDER) {
    const rows = filteredData[sectionName]
    const schema = CSV_SCHEMAS[sectionName]
    if (!rows || rows.length === 0) continue

    const filteredSchema = filterCsvSchema(schema, columns?.[sectionName])

    parts.push(`# ${sectionName.toUpperCase()}\n`)
    parts.push(
      csvStringify(rows, {
        header: true,
        columns: filteredSchema.columns,
        cast: { string: (value) => (value && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value) },
      }),
    )
    parts.push('\n')
  }

  return {
    buffer: Buffer.from(parts.join(''), 'utf8'),
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
    orgId: input.orgId,
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

  let _stage: 'data_fetch' | 'serialization' | undefined
  try {
    const scopedUserId = job.isAdmin ? job.targetUserId : job.userId
    _stage = 'data_fetch'
    const data = vaultsStore
      ? buildExportDataFromVaultStore(job.scope, scopedUserId, vaultsStore)
      : await buildExportDataFromDatabase(job.scope, scopedUserId)
    _stage = 'serialization'
    const { buffer, filename, readable } = serializeExportData(data, job.format, job.columns)
    _stage = undefined

    const s3Config = resolveS3Config()
    let s3Key: string | undefined
    if (s3Config) {
      const key = `exports/${job.id}/${filename}`
      const contentType = job.format === 'csv'
        ? 'text/csv; charset=utf-8'
        : job.format === 'json'
        ? 'application/json; charset=utf-8'
        : 'application/x-ndjson'
      if (job.format === 'ndjson' && readable) {
        await uploadToS3(s3Config, key, readable, contentType)
      } else if (buffer) {
        await uploadToS3(s3Config, key, buffer, contentType)
      }
      s3Key = key
    }
    await exportJobRepository.update({
      ...job,
      status: 'done',
      attempts: nextAttempt,
      completedAt: new Date().toISOString(),
      error: undefined,
      result: job.format === 'ndjson' ? undefined : buffer,
      filename,
      s3Key,
    })
    console.info(
      JSON.stringify(sanitizeExportTelemetry({
        level: 'info',
        event: 'exports.job_completed',
        jobId: job.id,
        format: job.format,
        scope: job.scope,
        attempt: nextAttempt,
        bytes: job.format === 'ndjson' ? undefined : buffer?.length,
        s3: s3Key ? true : false,
        completedAt: new Date().toISOString(),
      }, job)),
    )
    return
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const sanitizedMessage = sanitizePrivacyString(message, exportPiiValues(job))
    const retryable = nextAttempt < job.maxAttempts

    await exportJobRepository.update({
      ...job,
      status: retryable ? 'pending' : 'failed',
      attempts: nextAttempt,
      completedAt: retryable ? undefined : new Date().toISOString(),
      error: sanitizedMessage,
      result: undefined,
      filename: undefined,
    })

    console.error(
      JSON.stringify(sanitizeExportTelemetry({
        level: 'error',
        event: 'exports.job_failed',
        jobId: job.id,
        format: job.format,
        scope: job.scope,
        attempt: nextAttempt,
        retryable,
        error: message,
      }, job)),
    )

    if (!retryable) {
      const failureReason: FailureReason = (() => {
        if (_stage === 'data_fetch') return 'data_fetch_error'
        if (_stage === 'serialization') return 'serialization_error'
        return 'unknown_error'
      })()

      const entry: DlqEntry = {
        jobId: job.id,
        jobType: `${job.scope}:${job.format}`,
        failureReason,
        errorMessage: sanitizedMessage,
        attemptCount: nextAttempt,
        failedAt: new Date().toISOString(),
        sanitisedContext: sanitiseDlqContext(job),
      }

      dlqInsert(entry)

      safeInvokeMetricsHook({
        event: 'entry_added',
        jobId: entry.jobId,
        failureReason: entry.failureReason,
        dlqDepth: dlqStore.length,
        timestamp: entry.failedAt,
      })
    }

    const sanitizedError = new Error(sanitizedMessage)
    sanitizedError.name = error instanceof Error ? error.name : 'Error'
    throw sanitizedError
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
