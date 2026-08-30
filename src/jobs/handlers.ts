import { createHash } from 'node:crypto'
import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { EnqueueOptions, JobHandler, JobHandlerRegistry, JobPayloadByType, JobType } from './types.js'
import { TransactionETLService } from '../services/transactionETL.js'
import { MilestoneEmbeddingSource, ReindexCursorStore } from '../services/evidenceReindex.js'
import { EmbeddingProvider } from '../services/embeddingProvider.js'
import { buildSlashOnMissPayload } from '../services/soroban.js'
import {
  markVaultExpiries,
  sendMilestoneReminders,
  sendMilestoneDigestReminders,
  processDeferredReminders,
} from '../services/vaultExpiry.service.js'
import { cleanupExpiredSessions } from '../services/session.js'
import { purgeSoftDeletedVaults } from '../services/retention.js'
import { createAuditLog } from '../lib/audit-logs.js'
import { relayOutboxBatch } from '../services/outboxRelay.js'
import { runReindexBatches } from '../services/evidenceReindex.js'
import { renderOrgAnalyticsSnapshot } from '../services/analytics.service.js'
import {
  saveOrgReport,
  getAllOrgIds,
  checkAndIncrementReportQuota,
} from '../services/analyticsReports.js'
import { resolveS3Config, uploadToS3 } from '../services/exportS3.js'
import db from '../db/index.js'

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
    const expiredCount = await markVaultExpiries({ limit: 100 })
    const target = payload.vaultId ?? 'all-active-vaults'
    const deadline = payload.deadlineIso ?? 'not-provided'
    logJob(
      'deadline.check',
      `checked target=${target} deadline=${deadline} expired=${expiredCount} source=${payload.triggerSource} attempt=${context.attempt}`,
    )
    if (payload.vaultId) {
      const sorobanPayload = buildSlashOnMissPayload(payload.vaultId)
      logJob(
        'deadline.check',
        `slash_on_miss built vault=${payload.vaultId} status=${sorobanPayload.submission.status}`,
      )
    }
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
    logJob(
      'sessions.cleanup',
      `deleted=${deleted} batchSize=${batchSize} attempt=${context.attempt}`,
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
      const report = await renderOrgAnalyticsSnapshot(orgId)
      const key = `analytics/${orgId}/${createHash('sha256').update(`${orgId}:${context.jobId}`).digest('hex')}.json`
      const buffer = Buffer.from(JSON.stringify(report))
      if (s3Config) {
        await uploadToS3(s3Config, key, buffer, 'application/json')
        await saveOrgReport({
          orgId,
          s3Key: key,
          snapshotAt: report.snapshotAt,
          sizeBytes: buffer.byteLength,
        })
      } else {
        await saveOrgReport({
          orgId,
          localBuffer: buffer,
          snapshotAt: report.snapshotAt,
          sizeBytes: buffer.byteLength,
        })
      }
      generated += 1
    }
    logJob(
      'analytics.report.generate',
      `generated=${generated} skipped=${skipped} attempt=${context.attempt}`,
    )
  }

  jobHandlers['retention.purge'] = async (payload, context) => {
    const result = await purgeSoftDeletedVaults(payload.organizationId, payload.batchSize)
    logJob(
      'retention.purge',
      `org=${payload.organizationId} deletedVaults=${result.deletedVaults} deletedMilestones=${result.deletedMilestones} attempt=${context.attempt}`,
    )
  }

  jobHandlers['saved-search.evaluate'] = async (payload, context) => {
    // Placeholder for saved-search evaluation
    logJob('saved-search.evaluate', `evaluated=${payload.searchId} attempt=${context.attempt}`)
  }

  return jobHandlers
}
