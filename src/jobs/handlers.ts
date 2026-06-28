import { createHash } from 'node:crypto'
import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { JobHandler, JobType } from './types.js'
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
import { relayOutboxBatch } from '../services/outboxRelay.js'
import { runReindexBatches } from '../services/evidenceReindex.js'
import db from '../db/index.js'

type JobHandlerRegistry = {
  [K in JobType]: JobHandler<K>
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

const logJob = (type: JobType, message: string): void => {
  console.log(`[jobs:${type}] ${message}`)
}

export interface EmbeddingReindexDependencies {
  source: MilestoneEmbeddingSource
  cursorStore: ReindexCursorStore
  embeddingProvider: EmbeddingProvider
}

export const createDefaultJobHandlers = (
  notificationService: NotificationService,
  embeddingReindex: EmbeddingReindexDependencies,
): JobHandlerRegistry => ({
  'notification.send': async (payload, context) => {
    await notificationService.send(payload.recipient, payload.subject, payload.body)
    logJob('notification.send', `executed job_id=${context.jobId} attempt=${context.attempt}`)
  },
  'deadline.check': async (payload, context) => {
    await sleep(30)
    const expiredCount = await markVaultExpiries()
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
  'milestone.reminders.digest': async (payload, context) => {
    const result = await sendMilestoneDigestReminders({
      leadTimesMs: payload.leadTimesMs,
      limit: payload.limit,
    })
    logJob(
      'milestone.reminders.digest',
      `sent=${result.digestsSent} deferred=${result.digestsDeferred} milestones=${result.totalMilestones} attempt=${context.attempt}`,
    )
  },
  'milestone.reminders.deferred': async (payload, context) => {
    const delivered = await processDeferredReminders({
      batchSize: payload.batchSize,
    })
    logJob(
      'milestone.reminders.deferred',
      `delivered=${delivered} attempt=${context.attempt}`,
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
  'saved-search.evaluate': async (payload, context) => {
    const now = new Date()

    let searchQuery = db('org_vault_searches').where({ alerts_enabled: true })
    if (payload.searchId) {
      searchQuery = searchQuery.where({ id: payload.searchId })
    } else {
      searchQuery = searchQuery.whereRaw(
        `(last_evaluated_at IS NULL OR last_evaluated_at + (alert_frequency_ms || ' milliseconds')::interval <= ?)`,
        [now],
      )
    }

    const searches = await searchQuery.select('*')
    let evaluated = 0
    let notified = 0

    for (const search of searches) {
      try {
        const queryDef = typeof search.query_definition === 'string'
          ? JSON.parse(search.query_definition)
          : search.query_definition

        const limit = Math.min(100, Math.max(1, queryDef.limit ?? 20))

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
        vaultQuery = vaultQuery.orderBy(sortField, sortOrder).orderBy('id', 'desc').limit(limit)

        const rows = await vaultQuery
        const ids: string[] = rows.map((r: { id: string }) => r.id)
        const newHash = createHash('sha256').update(JSON.stringify(ids)).digest('hex')

        if (newHash !== search.last_result_hash) {
          await notificationService.send(
            search.alert_recipient,
            `Saved search "${search.name}" has new results`,
            `Your saved vault search "${search.name}" returned ${ids.length} result(s). The result set has changed since the last evaluation.`,
          )
          notified++
        }

        await db('org_vault_searches')
          .where({ id: search.id })
          .update({ last_evaluated_at: now, last_result_hash: newHash, updated_at: now })

        evaluated++
      } catch (evalError) {
        const msg = evalError instanceof Error ? evalError.message : String(evalError)
        logJob('saved-search.evaluate', `error evaluating search=${search.id}: ${msg}`)
      }
    }

    logJob(
      'saved-search.evaluate',
      `evaluated=${evaluated} notified=${notified} job_id=${context.jobId} attempt=${context.attempt}`,
    )
  },
})
