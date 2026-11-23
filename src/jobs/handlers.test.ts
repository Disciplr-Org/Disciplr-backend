// Jest ESM: handlers.ts pulls in many services (database, Soroban, S3, ...), so each of its
// imports is replaced with unstable_mockModule and handlers.js is imported dynamically afterwards.
// Nothing here touches the network, the database or the filesystem.
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { NotificationService } from '../services/notifications/factory.js'
import type { EmbeddingReindexDependencies } from './handlers.js'
import type { JobContext, JobHandler, JobPayloadByType, JobType } from './types.js'

// ─── Mocked collaborators ────────────────────────────────────
type SettlementOperation = {
  id: string
  status: 'pending' | 'submitted'
  vault_id: string
  target_milestone_id: string | null
  transaction_hash: string | null
  attempt_count: number
}

type Submission = { status: string; txHash?: string; error?: string }

const cleanupExpiredSessions = jest.fn<(batchSize: number) => Promise<number>>()
const purgeSoftDeletedVaults = jest.fn<(organizationId: string, batchSize?: number) => Promise<number>>()
const relayOutboxBatch = jest.fn<(batchSize?: number) => Promise<number>>()
const submitSlash = jest.fn<(vaultId: string, milestoneId: string | null) => Promise<{ submission: Submission }>>()
const markSettlementSubmitted = jest.fn<(id: string, txHash: string, trx: unknown) => Promise<void>>()
const confirmSettlementOperation = jest.fn<(id: string, txHash: string | null, trx: unknown) => Promise<void>>()
const recordSettlementAttemptFailure = jest.fn<
  (id: string, code: string, message: string, terminal: boolean, trx: unknown) => Promise<{ attemptCount: number; failureCode: string }>
>()
const reconcileVaults = jest.fn<
  (options: { vaultIds?: string[]; batchSize?: number }) => Promise<{
    totalVaults: number
    checked: number
    driftDetected: number
    missingOnChain: number
    errors: number
  }>
>()
const TransactionETLService = jest.fn<(config: Record<string, unknown>) => { reconcileVaults: typeof reconcileVaults }>()

// The settlement handler runs inside db.transaction(trx => ...) and reads rows through a chained
// query builder: trx('settlement_operations').whereIn().whereNotNull().orderBy().limit().forUpdate().skipLocked()
let queuedOperations: SettlementOperation[] = []
const builder = {
  whereIn: jest.fn(),
  whereNotNull: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  forUpdate: jest.fn(),
  skipLocked: jest.fn(),
}
const trx = jest.fn<(table: string) => typeof builder>(() => builder)
const transaction = jest.fn(async (callback: (t: typeof trx) => Promise<void>) => callback(trx))

jest.unstable_mockModule('../services/session.js', () => ({ cleanupExpiredSessions }))
jest.unstable_mockModule('../services/retention.js', () => ({ purgeSoftDeletedVaults }))
jest.unstable_mockModule('../services/outboxRelay.js', () => ({ relayOutboxBatch }))
jest.unstable_mockModule('../services/soroban.js', () => ({ submitSlash }))
jest.unstable_mockModule('../services/settlementOperations.js', () => ({
  markSettlementSubmitted,
  confirmSettlementOperation,
  recordSettlementAttemptFailure,
}))
jest.unstable_mockModule('../services/transactionETL.js', () => ({ TransactionETLService }))
jest.unstable_mockModule('../db/index.js', () => ({ default: { transaction } }))

// Imported by handlers.ts but not exercised by the handlers under test.
jest.unstable_mockModule('../services/notifications/factory.js', () => ({}))
jest.unstable_mockModule('../services/exportQueue.js', () => ({ processJob: jest.fn() }))
jest.unstable_mockModule('../services/evidenceReindex.js', () => ({ runReindexBatches: jest.fn() }))
jest.unstable_mockModule('../services/embeddingProvider.js', () => ({}))
jest.unstable_mockModule('../services/vaultExpiry.service.js', () => ({
  sendMilestoneReminders: jest.fn(),
  sendMilestoneDigestReminders: jest.fn(),
  processDeferredReminders: jest.fn(),
}))
jest.unstable_mockModule('../lib/audit-logs.js', () => ({ createAuditLog: jest.fn() }))
jest.unstable_mockModule('../services/analytics.service.js', () => ({ renderOrgAnalyticsSnapshot: jest.fn() }))
jest.unstable_mockModule('../services/analyticsReports.js', () => ({
  saveOrgReport: jest.fn(),
  getAllOrgIds: jest.fn(),
  checkAndIncrementReportQuota: jest.fn(),
}))
jest.unstable_mockModule('../services/exportS3.js', () => ({ resolveS3Config: jest.fn(), uploadToS3: jest.fn() }))

const { createDefaultJobHandlers } = await import('./handlers.js')

// ─── Helpers ─────────────────────────────────────────────────
const send = jest.fn<(recipient: string, subject: string, body: string) => Promise<void>>()
const notificationService = { send } as unknown as NotificationService
const embeddingReindex = {} as unknown as EmbeddingReindexDependencies

const context: JobContext = { jobId: 'job-1', attempt: 2 }
const handlers = createDefaultJobHandlers(notificationService, embeddingReindex)

function handlerFor<T extends JobType>(type: T): JobHandler<T> {
  const handler = handlers[type]
  if (!handler) throw new Error(`no handler registered for ${type}`)
  return handler as JobHandler<T>
}

const run = <T extends JobType>(type: T, payload: JobPayloadByType[T]) => handlerFor(type)(payload, context)

const operation = (overrides: Partial<SettlementOperation> = {}): SettlementOperation => ({
  id: 'op-1',
  status: 'pending',
  vault_id: 'vault-1',
  target_milestone_id: 'milestone-1',
  transaction_hash: null,
  attempt_count: 0,
  ...overrides,
})

const loggedLines = (spy: jest.SpiedFunction<typeof console.log>): string[] => spy.mock.calls.map((call) => String(call[0]))
const alerts = (spy: jest.SpiedFunction<typeof console.error>): Array<Record<string, unknown>> =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>)

describe('createDefaultJobHandlers', () => {
  let logSpy: jest.SpiedFunction<typeof console.log>
  let errorSpy: jest.SpiedFunction<typeof console.error>
  const savedEnv = {
    DRY_RUN: process.env.DRY_RUN,
    HORIZON_URL: process.env.HORIZON_URL,
    STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE,
  }

  beforeEach(() => {
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})

    delete process.env.DRY_RUN
    delete process.env.HORIZON_URL
    delete process.env.STELLAR_NETWORK_PASSPHRASE

    queuedOperations = []
    for (const method of [builder.whereIn, builder.whereNotNull, builder.orderBy, builder.limit, builder.forUpdate]) {
      method.mockReturnValue(builder)
    }
    builder.skipLocked.mockImplementation(async () => queuedOperations)

    markSettlementSubmitted.mockResolvedValue(undefined)
    confirmSettlementOperation.mockResolvedValue(undefined)
    recordSettlementAttemptFailure.mockImplementation(async (_id, code) => ({ attemptCount: 1, failureCode: code }))
    TransactionETLService.mockImplementation(() => ({ reconcileVaults }))
  })

  afterEach(() => {
    logSpy.mockRestore()
    errorSpy.mockRestore()
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('registers every handler this suite covers', () => {
    for (const type of [
      'notification.send',
      'sessions.cleanup',
      'retention.purge',
      'outbox.relay',
      'vault.reconcile',
      'settlement.process',
    ] as const) {
      expect(typeof handlers[type]).toBe('function')
    }
  })

  describe('notification.send', () => {
    it('sends the recipient, subject and body through the notification service', async () => {
      send.mockResolvedValue(undefined)

      await run('notification.send', { recipient: 'user@example.com', subject: 'Hello', body: 'World' })

      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith('user@example.com', 'Hello', 'World')
      expect(loggedLines(logSpy)).toEqual(['[jobs:notification.send] executed job_id=job-1 attempt=2'])
    })

    it('logs a structured error and rethrows so the queue can retry', async () => {
      const failure = new Error('smtp down')
      send.mockRejectedValue(failure)

      await expect(
        run('notification.send', { recipient: 'user@example.com', subject: 'Hello', body: 'World' }),
      ).rejects.toBe(failure)

      expect(alerts(errorSpy)).toEqual([
        {
          level: 'error',
          message: 'notification_send_failed',
          job_id: 'job-1',
          attempt: 2,
          recipient: 'user@example.com',
          subject: 'Hello',
          error: 'smtp down',
        },
      ])
      expect(JSON.stringify(alerts(errorSpy))).not.toContain('World') // the body is never logged
    })
  })

  describe('sessions.cleanup', () => {
    it('deletes expired sessions in the requested batch size', async () => {
      cleanupExpiredSessions.mockResolvedValue(7)

      await run('sessions.cleanup', { batchSize: 250 })

      expect(cleanupExpiredSessions).toHaveBeenCalledWith(250)
      expect(loggedLines(logSpy)).toEqual(['[jobs:sessions.cleanup] deleted=7 batchSize=250 attempt=2'])
    })

    it('defaults to a batch of 1000', async () => {
      cleanupExpiredSessions.mockResolvedValue(0)

      await run('sessions.cleanup', {})

      expect(cleanupExpiredSessions).toHaveBeenCalledWith(1000)
    })

    it('propagates a cleanup failure for retry', async () => {
      cleanupExpiredSessions.mockRejectedValue(new Error('db unavailable'))
      await expect(run('sessions.cleanup', {})).rejects.toThrow('db unavailable')
    })
  })

  describe('retention.purge', () => {
    it('purges soft-deleted vaults for the organization', async () => {
      purgeSoftDeletedVaults.mockResolvedValue(3)

      await run('retention.purge', { organizationId: 'org-1', batchSize: 25 })

      expect(purgeSoftDeletedVaults).toHaveBeenCalledWith('org-1', 25)
      expect(loggedLines(logSpy)).toEqual(['[jobs:retention.purge] purged=3 attempt=2'])
    })

    it('leaves the batch size to the service when the payload has none', async () => {
      purgeSoftDeletedVaults.mockResolvedValue(0)

      await run('retention.purge', { organizationId: 'org-2' })

      expect(purgeSoftDeletedVaults).toHaveBeenCalledWith('org-2', undefined)
    })
  })

  describe('outbox.relay', () => {
    it('relays one batch and reports how many events were relayed', async () => {
      relayOutboxBatch.mockResolvedValue(12)

      await run('outbox.relay', { batchSize: 40 })

      expect(relayOutboxBatch).toHaveBeenCalledWith(40)
      expect(loggedLines(logSpy)).toEqual(['[jobs:outbox.relay] relayed=12 attempt=2'])
    })

    it('leaves the batch size to the service when the payload has none', async () => {
      relayOutboxBatch.mockResolvedValue(0)

      await run('outbox.relay', {})

      expect(relayOutboxBatch).toHaveBeenCalledWith(undefined)
    })
  })

  describe('vault.reconcile', () => {
    const summary = { totalVaults: 10, checked: 8, driftDetected: 2, missingOnChain: 1, errors: 0 }

    it('reconciles the requested vaults with the testnet defaults', async () => {
      reconcileVaults.mockResolvedValue(summary)

      await run('vault.reconcile', { vaultIds: ['v1', 'v2'], batchSize: 5 })

      expect(TransactionETLService).toHaveBeenCalledWith({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        networkPassphrase: 'Test SDF Network ; September 2015',
        batchSize: 5,
        maxRetries: 3,
      })
      expect(reconcileVaults).toHaveBeenCalledWith({ vaultIds: ['v1', 'v2'], batchSize: 5 })
      expect(loggedLines(logSpy)).toEqual([
        '[jobs:vault.reconcile] vaultIds=2 batchSize=5 checked=8/10 drift=2 missing=1 errors=0 attempt=2',
      ])
    })

    it('reconciles all vaults in batches of 50 when the payload is empty', async () => {
      reconcileVaults.mockResolvedValue(summary)

      await run('vault.reconcile', {})

      expect(TransactionETLService).toHaveBeenCalledWith(expect.objectContaining({ batchSize: 50 }))
      expect(reconcileVaults).toHaveBeenCalledWith({ vaultIds: undefined, batchSize: undefined })
      expect(loggedLines(logSpy)[0]).toContain('vaultIds=all batchSize=50')
    })

    it('uses the Horizon URL and network passphrase from the environment', async () => {
      process.env.HORIZON_URL = 'https://horizon.example.test'
      process.env.STELLAR_NETWORK_PASSPHRASE = 'Example Network'
      reconcileVaults.mockResolvedValue(summary)

      await run('vault.reconcile', {})

      expect(TransactionETLService).toHaveBeenCalledWith(
        expect.objectContaining({ horizonUrl: 'https://horizon.example.test', networkPassphrase: 'Example Network' }),
      )
    })

    it('propagates a reconciliation failure for retry', async () => {
      reconcileVaults.mockRejectedValue(new Error('horizon unreachable'))
      await expect(run('vault.reconcile', {})).rejects.toThrow('horizon unreachable')
    })
  })

  describe('settlement.process', () => {
    it('skips submission entirely in DRY_RUN mode', async () => {
      process.env.DRY_RUN = 'true'

      await run('settlement.process', {})

      expect(transaction).not.toHaveBeenCalled()
      expect(submitSlash).not.toHaveBeenCalled()
      expect(loggedLines(logSpy)).toEqual(['[jobs:settlement.process] DRY_RUN: submission skipped attempt=2'])
    })

    it('locks a bounded batch of pending and submitted operations', async () => {
      for (const [requested, expected] of [
        [undefined, 20],
        [0, 1],
        [37, 37],
        [500, 100],
      ] as const) {
        builder.limit.mockClear()
        await run('settlement.process', { batchSize: requested })
        expect(builder.limit).toHaveBeenCalledWith(expected)
      }

      expect(trx).toHaveBeenCalledWith('settlement_operations')
      expect(builder.whereIn).toHaveBeenCalledWith('status', ['pending', 'submitted'])
      expect(builder.whereNotNull).toHaveBeenCalledWith('vault_id')
      expect(builder.orderBy).toHaveBeenCalledWith('created_at')
      expect(builder.forUpdate).toHaveBeenCalled()
      expect(builder.skipLocked).toHaveBeenCalled()
    })

    it('does nothing when there is no work', async () => {
      await run('settlement.process', {})

      expect(submitSlash).not.toHaveBeenCalled()
      expect(confirmSettlementOperation).not.toHaveBeenCalled()
      expect(recordSettlementAttemptFailure).not.toHaveBeenCalled()
    })

    it('only confirms an operation that was already submitted, without resubmitting it', async () => {
      queuedOperations = [operation({ status: 'submitted', transaction_hash: 'tx-existing' })]

      await run('settlement.process', {})

      expect(confirmSettlementOperation).toHaveBeenCalledWith('op-1', 'tx-existing', trx)
      expect(submitSlash).not.toHaveBeenCalled()
      expect(markSettlementSubmitted).not.toHaveBeenCalled()
      expect(loggedLines(logSpy)).toEqual([
        '[jobs:settlement.process] recovered confirmation operation=op-1 tx=tx-existing',
      ])
    })

    it('submits a pending operation, then records and confirms its transaction', async () => {
      queuedOperations = [operation()]
      submitSlash.mockResolvedValue({ submission: { status: 'success', txHash: 'tx-new' } })

      await run('settlement.process', {})

      expect(submitSlash).toHaveBeenCalledWith('vault-1', 'milestone-1')
      expect(markSettlementSubmitted).toHaveBeenCalledWith('op-1', 'tx-new', trx)
      expect(confirmSettlementOperation).toHaveBeenCalledWith('op-1', 'tx-new', trx)
      expect(markSettlementSubmitted.mock.invocationCallOrder[0]).toBeLessThan(
        confirmSettlementOperation.mock.invocationCallOrder[0],
      )
      expect(recordSettlementAttemptFailure).not.toHaveBeenCalled()
    })

    it('processes every operation in the batch even when one fails', async () => {
      queuedOperations = [operation({ id: 'op-a' }), operation({ id: 'op-b', vault_id: 'vault-2' })]
      submitSlash
        .mockResolvedValueOnce({ submission: { status: 'failed', error: 'network timeout' } })
        .mockResolvedValueOnce({ submission: { status: 'success', txHash: 'tx-b' } })

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith('op-a', 'NETWORK_ERROR', 'network timeout', false, trx)
      expect(confirmSettlementOperation).toHaveBeenCalledWith('op-b', 'tx-b', trx)
    })

    it('records a retryable failure without dead-lettering it', async () => {
      queuedOperations = [operation({ attempt_count: 1 })]
      submitSlash.mockResolvedValue({ submission: { status: 'failed', error: 'rpc connection reset' } })

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith('op-1', 'NETWORK_ERROR', 'rpc connection reset', false, trx)
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('classifies an unconfigured Soroban client as retryable SOROBAN_NOT_CONFIGURED', async () => {
      queuedOperations = [operation()]
      submitSlash.mockResolvedValue({ submission: { status: 'not_configured' } })

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith(
        'op-1',
        'SOROBAN_NOT_CONFIGURED',
        'Soroban submission is not configured',
        false,
        trx,
      )
    })

    it('dead-letters a contract rejection immediately and raises an alert', async () => {
      queuedOperations = [operation()]
      submitSlash.mockResolvedValue({ submission: { status: 'failed', error: 'contract error: vault is paused' } })
      recordSettlementAttemptFailure.mockResolvedValue({ attemptCount: 1, failureCode: 'CONTRACT_REJECTED' })

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith(
        'op-1',
        'CONTRACT_REJECTED',
        'contract error: vault is paused',
        true,
        trx,
      )
      expect(alerts(errorSpy)).toEqual([
        {
          level: 'alert',
          message: 'settlement_operation_dead_lettered',
          operation_id: 'op-1',
          vault_id: 'vault-1',
          attempts: 1,
          failure_code: 'CONTRACT_REJECTED',
        },
      ])
    })

    it('dead-letters a retryable failure once the fifth attempt is used', async () => {
      queuedOperations = [operation({ attempt_count: 4 })]
      submitSlash.mockResolvedValue({ submission: { status: 'failed', error: 'network timeout' } })
      recordSettlementAttemptFailure.mockResolvedValue({ attemptCount: 5, failureCode: 'RETRY_LIMIT_EXCEEDED' })

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith('op-1', 'RETRY_LIMIT_EXCEEDED', 'network timeout', true, trx)
      expect(alerts(errorSpy)[0]).toMatchObject({ message: 'settlement_operation_dead_lettered', attempts: 5 })
    })

    it('records a thrown submission error against the operation instead of failing the job', async () => {
      queuedOperations = [operation()]
      submitSlash.mockRejectedValue(new Error('socket hang up'))

      await expect(run('settlement.process', {})).resolves.toBeUndefined()

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith('op-1', 'NETWORK_ERROR', 'socket hang up', false, trx)
    })

    it('dead-letters a thrown contract rejection', async () => {
      queuedOperations = [operation()]
      submitSlash.mockRejectedValue(new Error('vault disputed'))

      await run('settlement.process', {})

      expect(recordSettlementAttemptFailure).toHaveBeenCalledWith('op-1', 'CONTRACT_REJECTED', 'vault disputed', true, trx)
    })

    it('truncates very long error messages before storing them', async () => {
      queuedOperations = [operation()]
      submitSlash.mockResolvedValue({ submission: { status: 'failed', error: 'x'.repeat(5000) } })

      await run('settlement.process', {})

      const stored = recordSettlementAttemptFailure.mock.calls[0][2]
      expect(stored).toHaveLength(2000)
    })
  })
})
