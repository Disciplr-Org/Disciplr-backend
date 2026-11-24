import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { EnqueueOptions, JobHandler, JobHandlerRegistry, JobPayloadByType, JobType } from './types.js'
import { TransactionETLService } from '../services/transactionETL.js'
import { MilestoneEmbeddingSource, ReindexCursorStore } from '../services/evidenceReindex.js'
import { EmbeddingProvider } from '../services/embeddingProvider.js'
import { submitSlash } from '../services/soroban.js'
import {
  confirmSettlementOperation,
  markSettlementSubmitted,
  recordSettlementAttemptFailure,
} from '../services/settlementOperations.js'
import {
  sendMilestoneReminders,
  sendMilestoneDigestReminders,
  processDeferredReminders,
} from '../services/vaultExpiry.service.js'
import { cleanupExpiredSessions } from '../services/session.js'
import { cleanupExpiredStepUpNonces } from '../services/stepUpStore.js'
import { runSavedSearch, hashResultSet } from '../routes/orgVaults.js'
import { isNotificationEnabled } from '../models/notificationPreferences.js'

export interface EmbeddingReindexDependencies {
  source: MilestoneEmbeddingSource
  cursorStore: ReindexCursorStore
  embeddingProvider: EmbeddingProvider
}

export type JobEnqueuer = <T extends JobType>(
  type: T,
  payload: JobPayloadByType[T],
  options?: EnqueueOptions,
) => void

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const logJob = (type: JobType, message: string): void => {
  console.log(`[jobs:${type}] ${message}`)
}

/**
 * Default job handler registry for the queue's retry and dead-letter flow.
 *
 * Retry/dead-letter contract:
 * - Handlers must throw on transient failures so the queue can retry them.
 * - Batch handlers fan out through `enqueueJob` when available so each unit
 *   has independent retry and dead-letter visibility.
 * - Handlers must use deterministic artifact keys so operator replays do not
 *   create duplicate side effects.
 */
export const createDefaultJobHandlers = (
  notificationService: NotificationService,
  embeddingReindex: EmbeddingReindexDependencies,
  enqueueJob?: JobEnqueuer,
): JobHandlerRegistry => {
  const jobHandlers: JobHandlerRegistry = {} as JobHandlerRegistry

  jobHandlers['notification.send'] = async (payload, context) => {
    try {
      await notificationService.send(payload.recipient, payload.subject, payload.body)
      logJob('notification.send', `executed job_id=${context.jobId} attempt=${context.attempt}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(
        JSON.stringify({
          level: 'error',
          message: 'notification_send_failed',
          job_id: context.jobId,
          attempt: context.attempt,
          recipient: payload.recipient,
          subject: payload.subject,
          error: message,
        }),
      )
      throw err
    }
  }

  jobHandlers['deadline.check'] = async (payload, context) => {
    await sleep(30)
    const target = payload.vaultId ?? 'all-active-vaults'
    const deadline = payload.deadlineIso ?? 'not-provided'
    logJob(
      'deadline.check',
      `checked target=${target} deadline=${deadline} source=${payload.triggerSource} attempt=${context.attempt}`,
    )
  }

  jobHandlers['settlement.process'] = async (payload, context) => {
    if (process.env.DRY_RUN === 'true') {
      logJob('settlement.process', `DRY_RUN: submission skipped attempt=${context.attempt}`)
      return
    }

    const batchSize = Math.min(Math.max(payload.batchSize ?? 20, 1), 100)
    const maxAttempts = 5
    await db.transaction(async (trx) => {
      const operations = await trx('settlement_operations')
        .whereIn('status', ['pending', 'submitted'])
        .whereNotNull('vault_id')
        .orderBy('created_at')
        .limit(batchSize)
        .forUpdate()
        .skipLocked()

      for (const operation of operations) {
        if (operation.status === 'submitted') {
          await confirmSettlementOperation(operation.id, operation.transaction_hash, trx)
          logJob('settlement.process', `recovered confirmation operation=${operation.id} tx=${operation.transaction_hash}`)
          continue
        }

        try {
          const result = await submitSlash(operation.vault_id, operation.target_milestone_id)
          if (result.submission.status === 'success' && result.submission.txHash) {
            await markSettlementSubmitted(operation.id, result.submission.txHash, trx)
            await confirmSettlementOperation(operation.id, result.submission.txHash, trx)
            logJob('settlement.process', `confirmed operation=${operation.id} tx=${result.submission.txHash}`)
            continue
          }

          const message = result.submission.error ?? 'Soroban submission is not configured'
          const nonRetryable = /contract|notactive|disputed|paused|deadline.?not.?reached/i.test(message)
          const networkFailure = /network|connection|timeout|rpc|fetch|socket/i.test(message)
          const nextAttempt = Number(operation.attempt_count) + 1
          const terminal = nonRetryable || nextAttempt >= maxAttempts
          const failureCode = nonRetryable ? 'CONTRACT_REJECTED' :
            result.submission.status === 'not_configured' ? 'SOROBAN_NOT_CONFIGURED' :
              networkFailure ? 'NETWORK_ERROR' : 'SOROBAN_SUBMISSION_FAILED'
          const updated = await recordSettlementAttemptFailure(
            operation.id,
            terminal && !nonRetryable ? 'RETRY_LIMIT_EXCEEDED' : failureCode,
            message.slice(0, 2000),
            terminal,
            trx,
          )
          if (terminal) {
            console.error(JSON.stringify({
              level: 'alert',
              message: 'settlement_operation_dead_lettered',
              operation_id: operation.id,
              vault_id: operation.vault_id,
              attempts: updated.attemptCount,
              failure_code: updated.failureCode,
            }))
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const nextAttempt = Number(operation.attempt_count) + 1
          const nonRetryable = /contract|notactive|disputed|paused|deadline.?not.?reached/i.test(message)
          const terminal = nonRetryable || nextAttempt >= maxAttempts
          const updated = await recordSettlementAttemptFailure(
            operation.id,
            nonRetryable ? 'CONTRACT_REJECTED' : terminal ? 'RETRY_LIMIT_EXCEEDED' : 'NETWORK_ERROR',
            message.slice(0, 2000) || 'Soroban submission failed',
            terminal,
            trx,
          )
          if (terminal) {
            console.error(JSON.stringify({
              level: 'alert',
              message: 'settlement_operation_dead_lettered',
              operation_id: operation.id,
              vault_id: operation.vault_id,
              attempts: updated.attemptCount,
              failure_code: updated.failureCode,
            }))
          }
        }
      }
    })
  }

  jobHandlers['oracle.call'] = async (payload, context) => {
    await sleep(60)
    const requestId = payload.requestId ?? context.jobId
    logJob(
      'oracle.call',
      `oracle=${payload.oracle} symbol=${payload.symbol} requestId=${requestId} attempt=${context.attempt}`,
    )
  }

  jobHandlers['analytics.recompute'] = async (payload, context) => {
    await sleep(120)
    const entity = payload.entityId ?? 'all'
    const reason = payload.reason ?? 'unspecified'
    logJob(
      'analytics.recompute',
      `scope=${payload.scope} entity=${entity} reason=${reason} attempt=${context.attempt}`,
    )
  }

  jobHandlers['export.generate'] = async (payload, context) => {
    await processExportJob(payload.exportJobId, undefined, context.attempt)
    logJob(
      'export.generate',
      `exportJobId=${payload.exportJobId} attempt=${context.attempt}`,
    )
  }

  jobHandlers['sessions.cleanup'] = async (payload, context) => {
    const batchSize = payload.batchSize ?? 1000
    const deleted = await cleanupExpiredSessions(batchSize)
    const deletedStepUpNonces = await cleanupExpiredStepUpNonces(batchSize)
    logJob(
      'sessions.cleanup',
      `deleted=${deleted} deletedStepUpNonces=${deletedStepUpNonces} batchSize=${batchSize} attempt=${context.attempt}`,
    )
  }

  jobHandlers['apiKeys.cleanup'] = async (payload, context) => {
    const batchSize = payload.batchSize ?? 1000
    const cleared = await cleanupExpiredRotationGrace(batchSize)
    logJob(
      'apiKeys.cleanup',
      `cleared=${cleared} batchSize=${batchSize} attempt=${context.attempt}`,
    )
  }

  jobHandlers['vault.reconcile'] = async (payload, context) => {
    const etlConfig = {
      horizonUrl: process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org',
      networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015',
      batchSize: payload.batchSize || 50,
      maxRetries: 3,
    }
    const etlService = new TransactionETLService(etlConfig)
    const result = await etlService.reconcileVaults({
      vaultIds: payload.vaultIds,
      batchSize: payload.batchSize,
    })
    logJob(
      'vault.reconcile',
      `vaultIds=${payload.vaultIds?.length || 'all'} batchSize=${payload.batchSize || 50} checked=${result.checked}/${result.totalVaults} drift=${result.driftDetected} missing=${result.missingOnChain} errors=${result.errors} attempt=${context.attempt}`,
    )
  }

  jobHandlers['outbox.relay'] = async (payload, context) => {
    const relayed = await relayOutboxBatch(payload.batchSize)
    logJob('outbox.relay', `relayed=${relayed} attempt=${context.attempt}`)
  }

  jobHandlers['embeddings.reindex'] = async (payload, context) => {
    const result = await runReindexBatches({
      source: embeddingReindex.source,
      cursorStore: embeddingReindex.cursorStore,
      embeddingProvider: embeddingReindex.embeddingProvider,
      batchSize: payload.batchSize,
      maxBatchesPerRun: payload.maxBatchesPerRun,
    })
    logJob(
      'embeddings.reindex',
      `batches=${result.batches} processed=${result.processed} reindexed=${result.reindexed} ` +
        `skipped=${result.skippedUpToDate} cursor=${result.cursor ?? 'none'} done=${result.done} attempt=${context.attempt}`,
    )
  }

  jobHandlers['milestone.reminders'] = async (payload, context) => {
    const remindersSent = await sendMilestoneReminders({
      leadTimesMs: payload.leadTimesMs,
      limit: payload.limit,
    })
    logJob(
      'milestone.reminders',
      `sent ${remindersSent} reminders attempt=${context.attempt}`,
    )
  }

  jobHandlers['milestone.reminders.digest'] = async (payload, context) => {
    const result = await sendMilestoneDigestReminders({
      leadTimesMs: payload.leadTimesMs,
      limit: payload.limit,
    })
    logJob(
      'milestone.reminders.digest',
      `sent=${result.digestsSent} deferred=${result.digestsDeferred} milestones=${result.totalMilestones} attempt=${context.attempt}`,
    )
  }

  jobHandlers['milestone.reminders.deferred'] = async (payload, context) => {
    const delivered = await processDeferredReminders({
      batchSize: payload.batchSize,
    })
    logJob(
      'milestone.reminders.deferred',
      `delivered=${delivered} attempt=${context.attempt}`,
    )
  }

  jobHandlers['analytics.report.generate'] = async (payload, context) => {
    const orgIds = payload.orgIds ?? (await getAllOrgIds())
    if (enqueueJob && orgIds.length > 1) {
      for (const orgId of orgIds) {
        enqueueJob('analytics.report.generate', { ...payload, orgIds: [orgId] })
      }
      logJob(
        'analytics.report.generate',
        `enqueued=${orgIds.length} attempt=${context.attempt}`,
      )
      return
    }
    const s3Config = resolveS3Config()
    let generated = 0
    let skipped = 0
    for (const orgId of orgIds) {
      if (!(await checkAndIncrementReportQuota(orgId))) {
        skipped += 1
        continue
      }
      const snapshot = await renderOrgAnalyticsSnapshot(orgId)
      const key = `analytics/${orgId}/${new Date().toISOString()}.json`
      const body = Buffer.from(JSON.stringify(snapshot))
      if (s3Config) {
        await uploadToS3(s3Config, key, body, 'application/json')
        await saveOrgReport({ orgId, s3Key: key, snapshotAt: new Date().toISOString(), sizeBytes: body.length })
      } else {
        await saveOrgReport({ orgId, localBuffer: new Uint8Array(body), snapshotAt: new Date().toISOString(), sizeBytes: body.length })
      }
      generated += 1
    }
    logJob(
      'analytics.report.generate',
      `generated=${generated} skipped=${skipped} attempt=${context.attempt}`,
    )
  }

  jobHandlers['retention.purge'] = async (payload, context) => {
    const purged = await purgeSoftDeletedVaults(payload.organizationId, payload.batchSize)
    logJob('retention.purge', `purged=${purged} attempt=${context.attempt}`)
  }

  jobHandlers['saved-search.evaluate'] = async (payload, context) => {
    const batchSize = Math.min(Math.max(payload.batchSize ?? 20, 1), 100)
    const now = new Date()

    await db.transaction(async (trx: any) => {
      let query = trx('org_vault_searches as s')
        .join('organizations as o', 'o.id', 's.org_id')
        .where('s.alerts_enabled', true)
        .where(function (this: any) {
          this.whereNull('s.last_evaluated_at').orWhereRaw(
            "s.last_evaluated_at <= NOW() - (s.alert_frequency_ms * interval '1 millisecond')",
          )
        })
        .select('s.*')

      if (payload.searchId) query = query.where('s.id', payload.searchId)

      const searches = await query
        .orderBy('s.last_evaluated_at', 'asc', 'nulls', 'first')
        .limit(batchSize)
        .forUpdate('s')
        .skipLocked()

      if (searches.length === 0) {
        logJob('saved-search.evaluate', `evaluated=0 attempt=${context.attempt}`)
        return
      }

      const orgIds = [...new Set(searches.map((search: any) => search.org_id as string))]
      const preferenceRows: Array<{ organization_id: string; category: string; enabled: boolean }> = await trx('org_notification_preferences')
        .whereIn('organization_id', orgIds)
        .where('channel', 'email')
        .whereIn('category', ['saved_search_match', ''])
        .select('organization_id', 'category', 'enabled')

      for (const search of searches as any[]) {
        const ids = await runSavedSearch(search.org_id, search.query_definition)
        const hash = hashResultSet(ids)
        const previousHash = search.last_result_hash as string | null
        const changed = previousHash !== hash

        await trx('org_vault_searches')
          .where({ id: search.id })
          .update({
            last_evaluated_at: now,
            last_result_hash: hash,
            last_matching_ids: JSON.stringify(ids),
            updated_at: now,
          })

        if (!changed || !search.alert_recipient) continue

        const orgRows = preferenceRows.filter((row) => row.organization_id === search.org_id)
        const categoryPreference = orgRows.find((row) => row.category === 'saved_search_match')
        const channelPreference = orgRows.find((row) => row.category === '')
        const enabled = categoryPreference?.enabled ?? channelPreference?.enabled ?? true
        if (!enabled) continue

        const recipient = String(search.alert_recipient)
        const subject = `New matches for saved search: ${search.name}`
        const body = `${ids.length} vault${ids.length === 1 ? '' : 's'} currently match this saved search.`

        if (enqueueJob) {
          enqueueJob('notification.send', { recipient, subject, body }, {
            idempotencyKey: `saved-search:${search.id}:${hash}`,
          })
        } else if (await isNotificationEnabled(search.org_id, 'saved_search_match', 'email')) {
          await notificationService.send(recipient, subject, body)
        }
      }
    })

    logJob('saved-search.evaluate', `evaluated=${payload.searchId ?? 'all'} batchSize=${batchSize} attempt=${context.attempt}`)
  }

  return jobHandlers
}
