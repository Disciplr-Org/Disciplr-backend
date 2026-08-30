import { createHash, randomUUID } from 'node:crypto'
import type { Knex } from 'knex'
import db from '../db/index.js'

export type SettlementOperationType = 'release' | 'redirect'
export type SettlementOperationStatus = 'pending' | 'submitted' | 'confirmed' | 'failed'

export interface SettlementOperation {
  id: string
  milestoneId: string
  operationKey: string
  operationType: SettlementOperationType
  status: SettlementOperationStatus
  attemptCount: number
  transactionHash: string | null
  failureCode: string | null
  failureMessage: string | null
  requestedBy: string
  requestFingerprint: string
  createdAt: string
  updatedAt: string
  submittedAt: string | null
  confirmedAt: string | null
}

export interface CreateSettlementOperationInput {
  milestoneId: string
  operationKey: string
  operationType: SettlementOperationType
  requestedBy: string
  destination: string
  amount: string
  assetCode?: string | null
}

/**
 * Completion consumers must call this guard before marking a milestone or
 * vault complete. Submission is deliberately not sufficient evidence of a
 * completed payout because the chain may reject or never include the tx.
 */
export const assertSettlementConfirmed = (operation: Pick<SettlementOperation, 'status'>): void => {
  if (operation.status !== 'confirmed') {
    throw new SettlementOperationError(
      'INVALID_STATE',
      `Settlement is not confirmed (current state: ${operation.status})`,
    )
  }
}

export class SettlementOperationError extends Error {
  constructor(
    public readonly code:
    | 'INVALID_INPUT'
    | 'IDENTITY_CONFLICT'
    | 'NOT_FOUND'
    | 'INVALID_STATE'
    | 'TRANSACTION_CONFLICT',
    message: string,
  ) {
    super(message)
    this.name = 'SettlementOperationError'
  }
}

const nowIso = (): string => new Date().toISOString()

/**
 * Small deterministic model of the operation contract.
 *
 * The database repository below is the production adapter. This model is
 * intentionally exported so worker code and tests can exercise retries and
 * process-restart recovery without requiring a live PostgreSQL instance. Its
 * snapshot format is also the shape used by recovery tooling.
 */
export class SettlementOperationLedger {
  private readonly operations = new Map<string, SettlementOperation>()
  private readonly identities = new Map<string, string>()

  create(input: CreateSettlementOperationInput): SettlementOperation {
    assertInput(input)
    const fingerprint = fingerprintFor(input)
    const identity = `${input.milestoneId.trim()}:${input.operationKey}`
    const existingId = this.identities.get(identity)
    if (existingId) {
      const existing = this.operations.get(existingId)!
      if (existing.requestFingerprint !== fingerprint) {
        throw new SettlementOperationError('IDENTITY_CONFLICT', 'operationKey is already bound to a different settlement request')
      }
      return { ...existing }
    }

    const timestamp = nowIso()
    const operation: SettlementOperation = {
      id: randomUUID(),
      milestoneId: input.milestoneId.trim(),
      operationKey: input.operationKey,
      operationType: input.operationType,
      status: 'pending',
      attemptCount: 0,
      transactionHash: null,
      failureCode: null,
      failureMessage: null,
      requestedBy: input.requestedBy.trim(),
      requestFingerprint: fingerprint,
      createdAt: timestamp,
      updatedAt: timestamp,
      submittedAt: null,
      confirmedAt: null,
    }
    this.identities.set(identity, operation.id)
    this.operations.set(operation.id, operation)
    return { ...operation }
  }

  get(operationId: string): SettlementOperation | null {
    const operation = this.operations.get(operationId)
    return operation ? { ...operation } : null
  }

  submit(operationId: string, transactionHash: string): SettlementOperation {
    this.assertTransactionHash(transactionHash)
    const current = this.require(operationId)
    if (current.status === 'confirmed') return { ...current }
    if (current.status === 'submitted') {
      if (current.transactionHash !== transactionHash) {
        throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Operation is already submitted with another transaction')
      }
      return { ...current }
    }
    if (current.status !== 'pending' && current.status !== 'failed') {
      throw new SettlementOperationError('INVALID_STATE', `Cannot submit operation in ${current.status} state`)
    }
    const updated = {
      ...current,
      status: 'submitted' as const,
      attemptCount: current.attemptCount + 1,
      transactionHash,
      failureCode: null,
      failureMessage: null,
      submittedAt: nowIso(),
      updatedAt: nowIso(),
    }
    this.operations.set(operationId, updated)
    return { ...updated }
  }

  confirm(operationId: string, transactionHash: string): SettlementOperation {
    const current = this.require(operationId)
    if (current.status === 'confirmed') {
      if (current.transactionHash !== transactionHash) {
        throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Confirmed operation has another transaction')
      }
      return { ...current }
    }
    if (current.status !== 'submitted') {
      throw new SettlementOperationError('INVALID_STATE', 'Only a submitted operation can be confirmed')
    }
    if (current.transactionHash !== transactionHash) {
      throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Confirmation does not match submitted transaction')
    }
    const updated = { ...current, status: 'confirmed' as const, confirmedAt: nowIso(), updatedAt: nowIso() }
    this.operations.set(operationId, updated)
    return { ...updated }
  }

  fail(operationId: string, failureCode: string, failureMessage: string): SettlementOperation {
    if (!/^[A-Z][A-Z0-9_:-]{1,63}$/.test(failureCode)) {
      throw new SettlementOperationError('INVALID_INPUT', 'failureCode has an invalid format')
    }
    if (!failureMessage.trim() || failureMessage.length > 2000) {
      throw new SettlementOperationError('INVALID_INPUT', 'failureMessage must contain 1–2000 characters')
    }
    const current = this.require(operationId)
    if (current.status === 'failed') return { ...current }
    if (current.status !== 'submitted') {
      throw new SettlementOperationError('INVALID_STATE', 'Only a submitted operation can fail')
    }
    const updated = {
      ...current,
      status: 'failed' as const,
      failureCode,
      failureMessage: failureMessage.trim(),
      updatedAt: nowIso(),
    }
    this.operations.set(operationId, updated)
    return { ...updated }
  }

  snapshot(): SettlementOperation[] {
    return [...this.operations.values()].map((operation) => ({ ...operation }))
  }

  restore(snapshot: SettlementOperation[]): void {
    this.operations.clear()
    this.identities.clear()
    for (const operation of snapshot) {
      this.operations.set(operation.id, { ...operation })
      this.identities.set(`${operation.milestoneId}:${operation.operationKey}`, operation.id)
    }
  }

  private require(operationId: string): SettlementOperation {
    const operation = this.operations.get(operationId)
    if (!operation) throw new SettlementOperationError('NOT_FOUND', 'Settlement operation not found')
    return operation
  }

  private assertTransactionHash(transactionHash: string): void {
    if (!TX_HASH_RE.test(transactionHash)) {
      throw new SettlementOperationError('INVALID_INPUT', 'transactionHash has an invalid format')
    }
  }
}

const OPERATION_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/
const TX_HASH_RE = /^[A-Za-z0-9_-]{8,128}$/

const assertInput = (input: CreateSettlementOperationInput): void => {
  if (!input || typeof input !== 'object') {
    throw new SettlementOperationError('INVALID_INPUT', 'Settlement operation input is required')
  }
  for (const [name, value] of Object.entries({
    milestoneId: input.milestoneId,
    operationKey: input.operationKey,
    requestedBy: input.requestedBy,
    destination: input.destination,
    amount: input.amount,
  })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new SettlementOperationError('INVALID_INPUT', `${name} must be a non-empty string`)
    }
  }
  if (!OPERATION_KEY_RE.test(input.operationKey)) {
    throw new SettlementOperationError('INVALID_INPUT', 'operationKey has an invalid format')
  }
  if (input.operationType !== 'release' && input.operationType !== 'redirect') {
    throw new SettlementOperationError('INVALID_INPUT', 'operationType must be release or redirect')
  }
  if (!Number.isFinite(Number(input.amount)) || Number(input.amount) <= 0) {
    throw new SettlementOperationError('INVALID_INPUT', 'amount must be a positive number')
  }
}

const fingerprintFor = (input: CreateSettlementOperationInput): string =>
  createHash('sha256')
    .update(JSON.stringify({
      milestoneId: input.milestoneId.trim(),
      operationType: input.operationType,
      destination: input.destination.trim(),
      amount: input.amount.trim(),
      assetCode: input.assetCode?.trim() ?? null,
    }))
    .digest('hex')

type SettlementOperationRow = {
  id: string
  milestone_id: string
  operation_key: string
  operation_type: SettlementOperationType
  status: SettlementOperationStatus
  attempt_count: number
  transaction_hash: string | null
  failure_code: string | null
  failure_message: string | null
  requested_by: string
  request_fingerprint: string
  created_at: Date | string
  updated_at: Date | string
  submitted_at: Date | string | null
  confirmed_at: Date | string | null
}

const iso = (value: Date | string | null): string | null =>
  value === null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString()

const mapRow = (row: SettlementOperationRow): SettlementOperation => ({
  id: row.id,
  milestoneId: row.milestone_id,
  operationKey: row.operation_key,
  operationType: row.operation_type,
  status: row.status,
  attemptCount: Number(row.attempt_count),
  transactionHash: row.transaction_hash,
  failureCode: row.failure_code,
  failureMessage: row.failure_message,
  requestedBy: row.requested_by,
  requestFingerprint: typeof row.request_fingerprint === 'string'
    ? row.request_fingerprint
    : JSON.stringify(row.request_fingerprint),
  createdAt: iso(row.created_at)!,
  updatedAt: iso(row.updated_at)!,
  submittedAt: iso(row.submitted_at),
  confirmedAt: iso(row.confirmed_at),
})

const clientFor = (trx?: Knex.Transaction): Knex => (trx ?? db) as Knex

const fetchByIdentity = async (
  client: Knex,
  milestoneId: string,
  operationKey: string,
): Promise<SettlementOperationRow | undefined> => client('settlement_operations')
  .where({ milestone_id: milestoneId, operation_key: operationKey })
  .first()

const fetchById = async (
  client: Knex,
  operationId: string,
  lock = false,
): Promise<SettlementOperationRow | undefined> => {
  let query = client('settlement_operations').where({ id: operationId })
  if (lock) query = query.forUpdate()
  return query.first()
}

/**
 * Create once or return the existing operation for the same logical key.
 * A reused key is safe only when its request fingerprint is identical.
 */
export const createSettlementOperation = async (
  input: CreateSettlementOperationInput,
  trx?: Knex.Transaction,
): Promise<SettlementOperation> => {
  assertInput(input)
  const client = clientFor(trx)
  const fingerprint = fingerprintFor(input)

  await client('settlement_operations')
    .insert({
      milestone_id: input.milestoneId.trim(),
      operation_key: input.operationKey,
      operation_type: input.operationType,
      requested_by: input.requestedBy.trim(),
      request_fingerprint: fingerprint,
    })
    .onConflict(['milestone_id', 'operation_key'])
    .ignore()

  const row = await fetchByIdentity(client, input.milestoneId.trim(), input.operationKey)
  if (!row) throw new SettlementOperationError('NOT_FOUND', 'Settlement operation was not created')
  if (row.request_fingerprint !== fingerprint) {
    throw new SettlementOperationError(
      'IDENTITY_CONFLICT',
      'operationKey is already bound to a different settlement request',
    )
  }
  return mapRow(row)
}

export const getSettlementOperation = async (operationId: string): Promise<SettlementOperation | null> => {
  if (!operationId.trim()) throw new SettlementOperationError('INVALID_INPUT', 'operationId is required')
  const row = await fetchById(db, operationId)
  return row ? mapRow(row) : null
}

/**
 * Claim a pending or failed operation for submission. The row lock and
 * conditional status update make concurrent workers converge on one attempt.
 * Confirmed operations are returned as-is so a client retry cannot submit a
 * second release or redirect.
 */
export const markSettlementSubmitted = async (
  operationId: string,
  transactionHash: string,
): Promise<SettlementOperation> => {
  if (!TX_HASH_RE.test(transactionHash)) {
    throw new SettlementOperationError('INVALID_INPUT', 'transactionHash has an invalid format')
  }

  return db.transaction(async (trx) => {
    const row = await fetchById(trx, operationId, true)
    if (!row) throw new SettlementOperationError('NOT_FOUND', 'Settlement operation not found')
    if (row.status === 'confirmed') return mapRow(row)
    if (row.status === 'submitted') {
      if (row.transaction_hash !== transactionHash) {
        throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Operation is already submitted with another transaction')
      }
      return mapRow(row)
    }
    if (row.status !== 'pending' && row.status !== 'failed') {
      throw new SettlementOperationError('INVALID_STATE', `Cannot submit operation in ${row.status} state`)
    }

    const now = new Date()
    const [updated] = await trx('settlement_operations')
      .where({ id: operationId, status: row.status })
      .update({
        status: 'submitted',
        attempt_count: Number(row.attempt_count) + 1,
        transaction_hash: transactionHash,
        failure_code: null,
        failure_message: null,
        submitted_at: now,
        updated_at: now,
      })
      .returning('*')
    if (!updated) throw new SettlementOperationError('INVALID_STATE', 'Operation changed during submission')
    return mapRow(updated)
  })
}

/** A callback may confirm only the exact submitted transaction. */
export const confirmSettlementOperation = async (
  operationId: string,
  transactionHash: string,
): Promise<SettlementOperation> => {
  return db.transaction(async (trx) => {
    const row = await fetchById(trx, operationId, true)
    if (!row) throw new SettlementOperationError('NOT_FOUND', 'Settlement operation not found')
    if (row.status === 'confirmed') {
      if (row.transaction_hash !== transactionHash) {
        throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Confirmed operation has another transaction')
      }
      return mapRow(row)
    }
    if (row.status !== 'submitted') {
      throw new SettlementOperationError('INVALID_STATE', 'Only a submitted operation can be confirmed')
    }
    if (row.transaction_hash !== transactionHash) {
      throw new SettlementOperationError('TRANSACTION_CONFLICT', 'Confirmation does not match submitted transaction')
    }
    const now = new Date()
    const [updated] = await trx('settlement_operations')
      .where({ id: operationId, status: 'submitted', transaction_hash: transactionHash })
      .update({ status: 'confirmed', confirmed_at: now, updated_at: now })
      .returning('*')
    if (!updated) throw new SettlementOperationError('INVALID_STATE', 'Operation changed during confirmation')
    return mapRow(updated)
  })
}

/** Record a recoverable failure without losing the operation identity. */
export const failSettlementOperation = async (
  operationId: string,
  failureCode: string,
  failureMessage: string,
): Promise<SettlementOperation> => {
  if (!/^[A-Z][A-Z0-9_:-]{1,63}$/.test(failureCode)) {
    throw new SettlementOperationError('INVALID_INPUT', 'failureCode has an invalid format')
  }
  if (!failureMessage.trim() || failureMessage.length > 2000) {
    throw new SettlementOperationError('INVALID_INPUT', 'failureMessage must contain 1–2000 characters')
  }
  return db.transaction(async (trx) => {
    const row = await fetchById(trx, operationId, true)
    if (!row) throw new SettlementOperationError('NOT_FOUND', 'Settlement operation not found')
    if (row.status === 'failed') return mapRow(row)
    if (row.status !== 'submitted') {
      throw new SettlementOperationError('INVALID_STATE', 'Only a submitted operation can fail')
    }
    const [updated] = await trx('settlement_operations')
      .where({ id: operationId, status: 'submitted' })
      .update({
        status: 'failed',
        failure_code: failureCode,
        failure_message: failureMessage.trim(),
        updated_at: new Date(),
      })
      .returning('*')
    if (!updated) throw new SettlementOperationError('INVALID_STATE', 'Operation changed during failure recording')
    return mapRow(updated)
  })
}
