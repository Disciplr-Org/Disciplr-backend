import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { URL } from 'node:url'
import type { S3Client } from '@aws-sdk/client-s3'
import {
  createJob,
  getJob,
  processJob,
  resetExportJobs,
  configureDlq,
  getDlqEntries,
  getDlqEntry,
  getDlqDepth,
  requeueDlqEntry,
  discardDlqEntry,
  clearDlq,
  resetDlq,
} from '../services/exportQueue.js'
import { resetS3ClientFactory, setS3ClientFactory } from '../services/exportS3.js'
import { maskPii } from '../utils/privacy.js'

const REQUESTER_USER_ID = 'user-raw-pii-123'
const TARGET_USER_ID = 'target-raw-pii-456'
const STELLAR_ADDRESS = 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB'
const EMAIL_ADDRESS = 'privacy@example.com'
const RAW_PII_VALUES = [REQUESTER_USER_ID, TARGET_USER_ID, STELLAR_ADDRESS, EMAIL_ADDRESS]
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i
const STELLAR_ACCOUNT_PATTERN = /\bG[A-Z2-7]{55}\b/

const originalEnv = { ...process.env }

const expectNoRawPii = (payload: string): void => {
  for (const value of RAW_PII_VALUES) {
    expect(payload).not.toContain(value)
  }
  expect(payload).not.toMatch(EMAIL_PATTERN)
  expect(payload).not.toMatch(STELLAR_ACCOUNT_PATTERN)
}

const createFailingS3Client = (errorMessage: string): S3Client => {
  const client = {
    send: jest.fn().mockRejectedValue(new Error(errorMessage)),
    config: {
      requestHandler: { metadata: { handlerProtocol: 'h2' } },
      endpointProvider: jest.fn().mockResolvedValue({ url: new URL('https://s3.us-east-1.amazonaws.com') }),
      region: async () => 'us-east-1',
      credentials: async () => ({
        accessKeyId: 'test-key',
        secretAccessKey: 'test-secret',
      }),
      signerConstructor: jest.fn(),
      systemClockOffset: 0,
    },
    middlewareStack: {
      clone: jest.fn().mockReturnThis(),
      use: jest.fn(),
      concat: jest.fn(),
      applyToStack: jest.fn(),
      identify: jest.fn(),
      identifyOnResolve: jest.fn(),
      resolve: jest.fn(),
      addRelativeTo: jest.fn(),
    },
  }

  return client as unknown as S3Client
}

const createFailedJob = async (
  failureMessage: string,
  overrides: { maxAttempts?: number; scope?: string; format?: string } = {},
): Promise<string> => {
  process.env.EXPORT_S3_BUCKET = 'dlq-test-bucket'
  process.env.EXPORT_S3_REGION = 'us-east-1'
  setS3ClientFactory(() => createFailingS3Client(failureMessage))

  const job = await createJob({
    userId: REQUESTER_USER_ID,
    isAdmin: true,
    targetUserId: TARGET_USER_ID,
    scope: (overrides.scope ?? 'vaults') as any,
    format: (overrides.format ?? 'json') as any,
    maxAttempts: overrides.maxAttempts ?? 1,
    requestHash: `hash-${Date.now()}`,
  })

  try {
    await processJob(job.id, [
      { id: 'vault-1', creator: REQUESTER_USER_ID, amount: '100', status: 'active', createdAt: '2030-01-01T00:00:00.000Z' },
    ])
  } catch {
    // expected to throw
  }

  return job.id
}

describe('Export dead-letter queue', () => {
  afterEach(async () => {
    process.env = { ...originalEnv }
    jest.restoreAllMocks()
    resetS3ClientFactory()
    await resetExportJobs()
    resetDlq()
  })

  describe('entry creation', () => {
    it('moves permanently failed export jobs to the DLQ', async () => {
      const jobId = await createFailedJob('permanent S3 failure')

      expect(getDlqDepth()).toBe(1)
      const entry = getDlqEntry(jobId)
      expect(entry).toBeDefined()
      expect(entry!.jobId).toBe(jobId)
      expect(entry!.jobType).toBe('vaults:json')
      expect(entry!.failureReason).toBe('unknown_error')
      expect(entry!.attemptCount).toBe(1)
      expect(entry!.failedAt).toBeDefined()
      expect(entry!.errorMessage).toBeDefined()
    })

    it('does not create DLQ entry for retryable failures', async () => {
      const jobId = await createFailedJob('transient S3 failure', { maxAttempts: 3 })

      expect(getDlqDepth()).toBe(0)
    })

    it('populates failureReason based on error context', async () => {
      const jobId = await createFailedJob('S3 upload failed')

      const entry = getDlqEntry(jobId)
      expect(entry).toBeDefined()
      expect(['serialization_error', 'data_fetch_error', 'unknown_error']).toContain(entry!.failureReason)
    })
  })

  describe('PII sanitisation', () => {
    it('sanitises PII fields in DLQ entries', async () => {
      const failureMessage = [
        `upload failed for requester ${REQUESTER_USER_ID}`,
        `target ${TARGET_USER_ID}`,
        `destination ${STELLAR_ADDRESS}`,
        `email ${EMAIL_ADDRESS}`,
      ].join(' ')

      const jobId = await createFailedJob(failureMessage)

      const entry = getDlqEntry(jobId)
      expect(entry).toBeDefined()

      const entryJson = JSON.stringify(entry)
      expectNoRawPii(entryJson)

      expect(entryJson).toContain(maskPii(REQUESTER_USER_ID))
      expect(entryJson).toContain(maskPii(TARGET_USER_ID))
    })
  })

  describe('DLQ cap eviction', () => {
    it('evicts oldest entry when DLQ overflows', async () => {
      configureDlq({ maxSize: 2 })

      const id1 = await createFailedJob('failure 1')
      const id2 = await createFailedJob('failure 2')
      const id3 = await createFailedJob('failure 3')

      expect(getDlqDepth()).toBe(2)
      expect(getDlqEntry(id1)).toBeUndefined()
      expect(getDlqEntry(id2)).toBeDefined()
      expect(getDlqEntry(id3)).toBeDefined()
    })
  })

  describe('query interface', () => {
    it('getDlqEntries returns a read-only snapshot newest-first', async () => {
      const id1 = await createFailedJob('failure A')
      const id2 = await createFailedJob('failure B')

      const entries = getDlqEntries()
      expect(entries).toHaveLength(2)
      expect(entries[0].jobId).toBe(id2)
      expect(entries[1].jobId).toBe(id1)

      entries.pop()
      expect(getDlqDepth()).toBe(2)
    })

    it('getDlqEntry returns undefined for unknown jobId', async () => {
      expect(getDlqEntry('nonexistent-job')).toBeUndefined()
    })

    it('getDlqDepth returns current count', async () => {
      expect(getDlqDepth()).toBe(0)
      await createFailedJob('failure X')
      expect(getDlqDepth()).toBe(1)
      await createFailedJob('failure Y')
      expect(getDlqDepth()).toBe(2)
    })
  })

  describe('drain operations', () => {
    it('requeueDlqEntry resets job to pending and removes from DLQ', async () => {
      const jobId = await createFailedJob('requeue test failure')

      expect(getDlqDepth()).toBe(1)

      const result = await requeueDlqEntry(jobId)
      expect(result).toBe(true)
      expect(getDlqEntry(jobId)).toBeUndefined()

      const job = await getJob(jobId)
      expect(job).toBeDefined()
      expect(job!.status).toBe('pending')
      expect(job!.attempts).toBe(0)
      expect(job!.error).toBeUndefined()
    })

    it('requeueDlqEntry returns false for unknown jobId', async () => {
      const result = await requeueDlqEntry('nonexistent-job')
      expect(result).toBe(false)
    })

    it('discardDlqEntry removes entry from DLQ', async () => {
      const jobId = await createFailedJob('discard test failure')

      expect(getDlqDepth()).toBe(1)

      const result = discardDlqEntry(jobId)
      expect(result).toBe(true)
      expect(getDlqEntry(jobId)).toBeUndefined()
      expect(getDlqDepth()).toBe(0)
    })

    it('discardDlqEntry returns false for unknown jobId', async () => {
      const result = discardDlqEntry('nonexistent-job')
      expect(result).toBe(false)
    })

    it('clearDlq removes all entries and returns count', async () => {
      await createFailedJob('clear test A')
      await createFailedJob('clear test B')
      await createFailedJob('clear test C')

      expect(getDlqDepth()).toBe(3)

      const count = clearDlq()
      expect(count).toBe(3)
      expect(getDlqDepth()).toBe(0)
    })

    it('clearDlq on empty DLQ returns 0', async () => {
      const count = clearDlq()
      expect(count).toBe(0)
    })
  })

  describe('MetricsHook', () => {
    it('invokes hook on entry_added with correct event data', async () => {
      const hook = jest.fn()
      configureDlq({ metricsHook: hook })

      const jobId = await createFailedJob('metrics entry test')

      expect(hook).toHaveBeenCalledTimes(1)
      const event = hook.mock.calls[0][0]
      expect(event.event).toBe('entry_added')
      expect(event.jobId).toBe(jobId)
      expect(event.failureReason).toBe('unknown_error')
      expect(event.dlqDepth).toBe(1)
      expect(event.timestamp).toBeDefined()
    })

    it('invokes hook on requeue, discard, and clear', async () => {
      const hook = jest.fn()
      configureDlq({ metricsHook: hook })

      const jobId = await createFailedJob('multi-event test')
      hook.mockClear()

      await requeueDlqEntry(jobId)
      expect(hook).toHaveBeenCalledTimes(1)
      expect(hook.mock.calls[0][0].event).toBe('entry_requeued')

      await createFailedJob('event test B')
      const jobIdB = (await getDlqEntries())[0].jobId
      hook.mockClear()

      discardDlqEntry(jobIdB)
      expect(hook).toHaveBeenCalledTimes(1)
      expect(hook.mock.calls[0][0].event).toBe('entry_discarded')

      await createFailedJob('event test C')
      hook.mockClear()

      clearDlq()
      expect(hook).toHaveBeenCalledTimes(1)
      expect(hook.mock.calls[0][0].event).toBe('dlq_cleared')
    })

    it('isolates hook errors without crashing normal operation', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      const hook = jest.fn(() => { throw new Error('hook failure') })
      configureDlq({ metricsHook: hook })

      const jobId = await createFailedJob('hook error test')

      const entry = getDlqEntry(jobId)
      expect(entry).toBeDefined()
      expect(hook).toHaveBeenCalled()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('operates normally when no MetricsHook is configured', async () => {
      resetDlq()

      const jobId = await createFailedJob('no hook test')

      expect(getDlqDepth()).toBe(1)
      expect(getDlqEntry(jobId)).toBeDefined()
    })
  })
})
