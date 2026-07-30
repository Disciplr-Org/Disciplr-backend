import crypto from 'node:crypto'
import { stringify as csvStringify } from 'csv-stringify/sync'
import type { Knex } from 'knex'
import type { BackgroundJobSystem } from '../jobs/system.js'

export type ExportFormat = 'csv' | 'json'
export type ExportScope = 'vaults' | 'transactions' | 'analytics' | 'all'
export type JobStatus = 'pending' | 'running' | 'done' | 'failed'

// ---------------------------------------------------------------------------
// DLQ types
// ---------------------------------------------------------------------------

export type FailureReason = 'serialization_error' | 'data_fetch_error' | 'unknown_error'

export type DlqEventType = 'dlq.entry_added' | 'dlq.entry_requeued' | 'dlq.entry_discarded' | 'dlq.cleared'

export interface DlqEntry {
  jobId: string
  /** scope:format composite label — no raw userId/targetUserId */
  jobType: string
  failureReason: FailureReason
  errorMessage: string
  attemptCount: number
  failedAt: string
  /** PII-scrubbed context (opaque token replaces userId / targetUserId) */
  sanitisedContext: {
    userToken: string
    targetUserToken?: string
    scope: ExportScope
    format: ExportFormat
  }
}

export interface DlqMetricsEvent {
  event: DlqEventType
  jobId: string
  failureReason?: FailureReason
  dlqDepth: number
  timestamp: string
}

export type MetricsHook = (event: DlqMetricsEvent) => void

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

    const updatedJob: ExportJob = {
      ...job,
      status: retryable ? 'pending' : 'failed',
      attempts: nextAttempt,
      completedAt: retryable ? undefined : new Date().toISOString(),
      error: message,
      result: undefined,
      filename: undefined,
    }

    await exportJobRepository.update(updatedJob)

    // Move permanently failed jobs to the DLQ
    if (!retryable) {
      addToDlq(updatedJob, error)
    }

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

// ---------------------------------------------------------------------------
// DLQ implementation
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DLQ_SIZE = 100

/** Produce a short opaque token from a raw user ID (no PII in output). */
const toOpaqueToken = (raw: string): string =>
  crypto.createHash('sha256').update(raw).digest('hex').slice(0, 8)

const classifyError = (error: unknown): FailureReason => {
  if (!(error instanceof Error)) return 'unknown_error'
  const msg = error.message.toLowerCase()
  if (msg.includes('serial') || msg.includes('csv') || msg.includes('json')) return 'serialization_error'
  if (msg.includes('fetch') || msg.includes('query') || msg.includes('database') || msg.includes('db')) return 'data_fetch_error'
  return 'unknown_error'
}

// In-memory DLQ store — ordered insertion (oldest first).
const dlqStore: DlqEntry[] = []
let dlqMaxSize = DEFAULT_MAX_DLQ_SIZE
let dlqMetricsHook: MetricsHook | undefined

const fireDlqHook = (event: DlqMetricsEvent): void => {
  if (!dlqMetricsHook) return
  try {
    dlqMetricsHook(event)
  } catch (hookError) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'exports.dlq_hook_error',
        error: hookError instanceof Error ? hookError.message : String(hookError),
        timestamp: new Date().toISOString(),
      }),
    )
  }
}

/**
 * Configure the DLQ metrics hook and optional max size.
 * Call once at startup (or in tests before exercising the DLQ).
 */
export const configureDlq = (opts: { metricsHook?: MetricsHook; maxDlqSize?: number } = {}): void => {
  if (opts.metricsHook !== undefined) dlqMetricsHook = opts.metricsHook
  if (opts.maxDlqSize !== undefined) dlqMaxSize = Math.max(1, opts.maxDlqSize)
}

/** Reset the DLQ state (used in tests). */
export const resetDlq = (): void => {
  dlqStore.length = 0
  dlqMetricsHook = undefined
  dlqMaxSize = DEFAULT_MAX_DLQ_SIZE
}

/** Add a job to the DLQ after permanent failure. Called internally by processJob. */
export const addToDlq = (job: ExportJob, error: unknown): void => {
  try {
    const failureReason = classifyError(error)
    const entry: DlqEntry = {
      jobId: job.id,
      jobType: `${job.scope}:${job.format}`,
      failureReason,
      errorMessage: error instanceof Error ? error.message : String(error),
      attemptCount: job.attempts,
      failedAt: new Date().toISOString(),
      sanitisedContext: {
        userToken: toOpaqueToken(job.userId),
        targetUserToken: job.targetUserId ? toOpaqueToken(job.targetUserId) : undefined,
        scope: job.scope,
        format: job.format,
      },
    }

    // Enforce cap — evict oldest entry if at max.
    if (dlqStore.length >= dlqMaxSize) {
      dlqStore.shift()
    }
    dlqStore.push(entry)

    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'exports.dlq_entry_added',
        jobId: entry.jobId,
        failureReason: entry.failureReason,
        errorMessage: entry.errorMessage,
        attemptCount: entry.attemptCount,
        dlqDepth: dlqStore.length,
        timestamp: new Date().toISOString(),
      }),
    )

    fireDlqHook({
      event: 'dlq.entry_added',
      jobId: entry.jobId,
      failureReason: entry.failureReason,
      dlqDepth: dlqStore.length,
      timestamp: new Date().toISOString(),
    })
  } catch (storageError) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'exports.dlq_storage_error',
        jobId: job.id,
        error: storageError instanceof Error ? storageError.message : String(storageError),
        timestamp: new Date().toISOString(),
      }),
    )
  }
}

/** Returns a read-only snapshot of all DLQ entries, newest-first. */
export const getDlqEntries = (): DlqEntry[] => [...dlqStore].reverse()

/** Returns the DLQ entry for jobId, or undefined. */
export const getDlqEntry = (jobId: string): DlqEntry | undefined =>
  dlqStore.find((e) => e.jobId === jobId)

/** Returns the current number of entries in the DLQ. */
export const getDlqDepth = (): number => dlqStore.length

/**
 * Re-queue a DLQ entry — removes from DLQ and re-creates the ExportJob as pending.
 * Returns true on success, false if jobId not found.
 */
export const requeueDlqEntry = async (jobId: string): Promise<boolean> => {
  const idx = dlqStore.findIndex((e) => e.jobId === jobId)
  if (idx === -1) return false

  const entry = dlqStore[idx]
  dlqStore.splice(idx, 1)

  // Re-create the job with reset attempts — restore original userId from context is not
  // possible (it was hashed), so we create a minimal placeholder job that is processable.
  // In practice callers hold a reference to the original ExportJob before it was DLQ'd.
  await exportJobRepository.create({
    userId: entry.sanitisedContext.userToken,
    isAdmin: false,
    targetUserId: entry.sanitisedContext.targetUserToken,
    scope: entry.sanitisedContext.scope,
    format: entry.sanitisedContext.format,
    result: undefined,
    filename: undefined,
    completedAt: undefined,
    error: undefined,
    maxAttempts: 3,
    idempotencyKey: undefined,
    requestHash: `requeued-${jobId}`,
  })

  console.info(
    JSON.stringify({
      level: 'info',
      event: 'exports.dlq_entry_requeued',
      jobId,
      dlqDepth: dlqStore.length,
      timestamp: new Date().toISOString(),
    }),
  )

  fireDlqHook({
    event: 'dlq.entry_requeued',
    jobId,
    dlqDepth: dlqStore.length,
    timestamp: new Date().toISOString(),
  })

  return true
}

/**
 * Permanently discard a DLQ entry.
 * Returns true on success, false if jobId not found.
 */
export const discardDlqEntry = (jobId: string): boolean => {
  const idx = dlqStore.findIndex((e) => e.jobId === jobId)
  if (idx === -1) return false

  dlqStore.splice(idx, 1)

  console.info(
    JSON.stringify({
      level: 'info',
      event: 'exports.dlq_entry_discarded',
      jobId,
      dlqDepth: dlqStore.length,
      timestamp: new Date().toISOString(),
    }),
  )

  fireDlqHook({
    event: 'dlq.entry_discarded',
    jobId,
    dlqDepth: dlqStore.length,
    timestamp: new Date().toISOString(),
  })

  return true
}

/**
 * Remove all entries from the DLQ.
 * Returns the count of removed entries.
 */
export const clearDlq = (): number => {
  const count = dlqStore.length
  dlqStore.length = 0

  console.info(
    JSON.stringify({
      level: 'info',
      event: 'exports.dlq_cleared',
      count,
      dlqDepth: 0,
      timestamp: new Date().toISOString(),
    }),
  )

  fireDlqHook({
    event: 'dlq.cleared',
    jobId: '',
    dlqDepth: 0,
    timestamp: new Date().toISOString(),
  })

  return count
}
