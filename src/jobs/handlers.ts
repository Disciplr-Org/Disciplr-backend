import { NotificationService } from '../services/notifications/factory.js'
import { processJob as processExportJob } from '../services/exportQueue.js'
import type { JobHandler, JobType } from './types.js'
import { markVaultExpiries } from '../services/vault.js'

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

export const defaultJobHandlers: JobHandlerRegistry = {
  'notification.send': async (payload, context) => {
    await NotificationService.send(payload.recipient, payload.subject, payload.body)
    logJob(
      'notification.send',
      `executed job_id=${context.jobId} attempt=${context.attempt}`,
    )
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
}
