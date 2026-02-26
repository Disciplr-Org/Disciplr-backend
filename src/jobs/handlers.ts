import type { JobHandler, JobType } from './types.js'

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
    await sleep(40)
    logJob(
      'notification.send',
      `sent recipient=${payload.recipient} subject="${payload.subject}" attempt=${context.attempt}`,
    )
  },
  'deadline.check': async (payload, context) => {
    await sleep(30)
    const target = payload.vaultId ?? 'all-active-vaults'
    const deadline = payload.deadlineIso ?? 'not-provided'
    logJob(
      'deadline.check',
      `checked target=${target} deadline=${deadline} source=${payload.triggerSource} attempt=${context.attempt}`,
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
}
