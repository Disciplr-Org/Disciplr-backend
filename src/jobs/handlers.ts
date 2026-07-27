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

    for (const search of batch) {
      try {
        const queryDef = typeof search.query_definition === 'string'
          ? JSON.parse(search.query_definition)
          : search.query_definition

        const queryLimit = Math.min(100, Math.max(1, queryDef.limit ?? 20))

        let vaultQuery = db('vaults')
          .where('organization_id', search.org_id)
          .whereNull('deleted_at')
          .select('id')

        if (queryDef.status) vaultQuery = vaultQuery.where('status', queryDef.status)
        if (queryDef.verifier) vaultQuery = vaultQuery.where('verifier', queryDef.verifier)
        if (queryDef.amount_min) vaultQuery = vaultQuery.where('amount', '>=', queryDef.amount_min)
        if (queryDef.amount_max) vaultQuery = vaultQuery.where('amount', '<=', queryDef.amount_max)
        if (queryDef.date_from) vaultQuery = vaultQuery.where('created_at', '>=', new Date(queryDef.date_from))
        if (queryDef.date_to) vaultQuery = vaultQuery.where('created_at', '<=', new Date(queryDef.date_to))

        const sortField = queryDef.sort_by ?? 'created_at'
        const sortOrder = (queryDef.sort_order ?? 'desc') as 'asc' | 'desc'
        vaultQuery = vaultQuery.orderBy(sortField, sortOrder).orderBy('id', 'desc').limit(queryLimit)

        const rows = await vaultQuery
        const ids: string[] = rows.map((r: { id: string }) => r.id)
        const newHash = createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')

        if (newHash !== search.last_result_hash) {
          await notificationService.send(
            search.alert_recipient,
            `Saved search "${search.name}" has new results`,
            `Your saved vault search "${search.name}" returned ${ids.length} result(s). The result set has changed since the last evaluation.`,
          )
          notified++
        }
        const report = await renderOrgAnalyticsSnapshot(orgId)
        const key = `analytics/${orgId}/${Date.now()}.json`
        await uploadToS3(s3Config, key, JSON.stringify(report))
        await saveOrgReport(orgId, key)
        generated += 1
      }
      logJob(
        'analytics.report.generate',
        `generated=${generated} skipped=${skipped} attempt=${context.attempt}`,
      )
    }

    jobHandlers['retention.purge'] = async (payload, context) => {
      const purged = await purgeSoftDeletedVaults({ batchSize: payload.batchSize })
      logJob('retention.purge', `purged=${purged} attempt=${context.attempt}`)
    }

    jobHandlers['outbox.relay'] = async (payload, context) => {
      const relayed = await relayOutboxBatch(payload.batchSize)
      logJob('outbox.relay', `relayed=${relayed} attempt=${context.attempt}`)
    }

    jobHandlers['embeddings.reindex'] = async (payload, context) => {
      const batches = await runReindexBatches(embeddingReindex, payload)
      logJob('embeddings.reindex', `batches=${batches} attempt=${context.attempt}`)
    }

    jobHandlers['saved-search.evaluate'] = async (payload, context) => {
      // Placeholder for saved-search evaluation
      logJob('saved-search.evaluate', `evaluated=${payload.searchId} attempt=${context.attempt}`)
    }
  }

  return jobHandlers as JobHandlerRegistry
}
