import { createHash } from 'node:crypto'
import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { EnqueueOptions, JobHandler, JobPayloadByType, JobType } from './types.js'
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

export const createDefaultJobHandlers = (
  notificationService: NotificationService,
  embeddingReindex: EmbeddingReindexDependencies,
  enqueueJob?: JobEnqueuer,
): JobHandlerRegistry => {
  const jobHandlers: JobHandlerRegistry = {
    'notification.send': async (payload, context) => {
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
    },
    'deadline.check': async (payload, context) => {
      await sleep(30)
      const batchSize = payload.batchSize ?? 100
      const expiredCount = await markVaultExpiries({ limit: batchSize })
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
    },
    'oracle.call': async (payload, context) => {
      await sleep(60)
      const requestId = payload.requestId ?? context.jobId
      logJob(
        'oracle.call',
        `oracle=${payload.oracle} symbol=${payload.symbol} requestId=${requestId} attempt=${context.attempt}`,
      )
    },
    'analytics.recompute': async (payload, context) => {
      await sleep(120)
      const entity = payload.entityId ?? 'all'
      const reason = payload.reason ?? 'unspecified'
      logJob(
        'analytics.recompute',
        `scope=${payload.scope} entity=${entity} reason=${reason} attempt=${context.attempt}`,
      )
    },
    'export.generate': async (payload, context) => {
      await processExportJob(payload.exportJobId, undefined, context.attempt)
      logJob(
        'export.generate',
        `exportJobId=${payload.exportJobId} attempt=${context.attempt}`,
      )
    },
    'sessions.cleanup': async (payload, context) => {
      const batchSize = payload.batchSize ?? 1000
      const deleted = await cleanupExpiredSessions(batchSize)
      logJob(
        'sessions.cleanup',
        `deleted=${deleted} batchSize=${batchSize} attempt=${context.attempt}`,
      )
    },
  }

  if (enqueueJob) {
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
  },
  'milestone.reminders': async (payload, context) => {
    const remindersSent = await sendMilestoneReminders({
      leadTimesMs: payload.leadTimesMs,
      limit: payload.limit,
    })
    logJob(
      'milestone.reminders',
      `sent ${remindersSent} reminders attempt=${context.attempt}`,
    )
  },
  'oracle.call': async (payload, context) => {
    await sleep(60)
    const requestId = payload.requestId ?? context.jobId
    logJob(
      'oracle.call',
      `oracle=${payload.oracle} symbol=${payload.symbol} requestId=${requestId} attempt=${context.attempt}`,
    )
  },
  'analytics.recompute': async (payload, context) => {
    await sleep(120)
    const entity = payload.entityId ?? 'all'
    const reason = payload.reason ?? 'unspecified'
    logJob(
      'analytics.recompute',
      `scope=${payload.scope} entity=${entity} reason=${reason} attempt=${context.attempt}`,
    )
  },
  'export.generate': async (payload, context) => {
    await processExportJob(payload.exportJobId, undefined, context.attempt)
    logJob(
      'export.generate',
      `exportJobId=${payload.exportJobId} attempt=${context.attempt}`,
    )
  },
  'vault.reconcile': async (payload, context) => {
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
  },
  'sessions.cleanup': async (payload, context) => {
    const batchSize = payload.batchSize ?? 1000
    const deleted = await cleanupExpiredSessions(batchSize)
    logJob(
      'sessions.cleanup',
      `deleted=${deleted} batchSize=${batchSize} attempt=${context.attempt}`,
    )
  },
  'outbox.relay': async (payload, context) => {
    const count = await relayOutboxBatch()
    logJob(
      'outbox.relay',
      `relayed=${count} attempt=${context.attempt}`,
    )
  },
  'embeddings.reindex': async (payload, context) => {
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
  },
})
