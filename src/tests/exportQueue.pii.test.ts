import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { URL } from 'node:url'
import type { S3Client } from '@aws-sdk/client-s3'
import {
  createJob,
  getJob,
  processJob,
  resetExportJobs,
} from '../services/exportQueue.js'
import { resetS3ClientFactory, setS3ClientFactory } from '../services/exportS3.js'
import { maskPii, sanitizePrivacyPayload } from '../utils/privacy.js'

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

describe('Export queue PII sanitisation', () => {
  afterEach(async () => {
    process.env = { ...originalEnv }
    jest.restoreAllMocks()
    resetS3ClientFactory()
    await resetExportJobs()
  })

  it('sanitises failed job records and structured failure logs', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    const failureMessage = [
      `upload failed for requester ${REQUESTER_USER_ID}`,
      `target ${TARGET_USER_ID}`,
      `destination ${STELLAR_ADDRESS}`,
      `email ${EMAIL_ADDRESS}`,
    ].join(' ')

    process.env.EXPORT_S3_BUCKET = 'privacy-export-bucket'
    process.env.EXPORT_S3_REGION = 'us-east-1'
    setS3ClientFactory(() => createFailingS3Client(failureMessage))

    const job = await createJob({
      userId: REQUESTER_USER_ID,
      isAdmin: true,
      targetUserId: TARGET_USER_ID,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 1,
      requestHash: 'hash-pii-failure',
    })

    let thrownError: unknown
    try {
      await processJob(job.id, [
        {
          id: 'vault-pii',
          creator: REQUESTER_USER_ID,
          amount: '100',
          status: 'active',
          successDestination: STELLAR_ADDRESS,
          failureDestination: EMAIL_ADDRESS,
          createdAt: '2030-01-01T00:00:00.000Z',
        },
      ])
    } catch (error) {
      thrownError = error
    }

    expect(thrownError).toBeInstanceOf(Error)
    const thrownMessage = thrownError instanceof Error ? thrownError.message : String(thrownError)
    expect(thrownMessage).not.toBe(failureMessage)
    expect(thrownMessage).toContain(maskPii(REQUESTER_USER_ID))
    expect(thrownMessage).toContain(maskPii(TARGET_USER_ID))
    expectNoRawPii(thrownMessage)

    const failedJob = await getJob(job.id)
    expect(failedJob?.status).toBe('failed')
    expect(failedJob?.error).toContain(maskPii(REQUESTER_USER_ID))
    expect(failedJob?.error).toContain(maskPii(TARGET_USER_ID))
    expect(failedJob?.error).toContain(maskPii(STELLAR_ADDRESS))
    expect(failedJob?.error).toContain(maskPii(EMAIL_ADDRESS))
    expectNoRawPii(failedJob?.error ?? '')

    const failureLog = errorSpy.mock.calls.map(([entry]) => String(entry)).join('\n')
    expect(failureLog).toContain('"event":"exports.job_failed"')
    expect(failureLog).toContain(maskPii(REQUESTER_USER_ID))
    expect(failureLog).toContain(maskPii(TARGET_USER_ID))
    expectNoRawPii(failureLog)
  })

  it('emits only deterministic user tokens in completion logs', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => undefined)

    const job = await createJob({
      userId: REQUESTER_USER_ID,
      isAdmin: true,
      targetUserId: TARGET_USER_ID,
      scope: 'vaults',
      format: 'json',
      maxAttempts: 3,
      requestHash: 'hash-pii-success',
    })

    await processJob(job.id, [
      {
        id: 'vault-pii-success',
        creator: REQUESTER_USER_ID,
        amount: '100',
        status: 'active',
        successDestination: STELLAR_ADDRESS,
        failureDestination: EMAIL_ADDRESS,
        createdAt: '2030-01-01T00:00:00.000Z',
      },
    ])

    const completionLog = infoSpy.mock.calls.map(([entry]) => String(entry)).join('\n')
    expect(completionLog).toContain('"event":"exports.job_completed"')
    expect(completionLog).toContain(maskPii(REQUESTER_USER_ID))
    expect(completionLog).toContain(maskPii(TARGET_USER_ID))
    expectNoRawPii(completionLog)
  })

  it('recursively sanitises export telemetry payloads', () => {
    const sanitized = sanitizePrivacyPayload(
      {
        userId: REQUESTER_USER_ID,
        targetUserId: TARGET_USER_ID,
        context: {
          creator: STELLAR_ADDRESS,
          successDestination: STELLAR_ADDRESS,
          failureDestination: EMAIL_ADDRESS,
          message: `export for ${REQUESTER_USER_ID} ${TARGET_USER_ID} ${STELLAR_ADDRESS} ${EMAIL_ADDRESS}`,
        },
      },
      [REQUESTER_USER_ID, TARGET_USER_ID],
    )

    const encodedPayload = JSON.stringify(sanitized)
    expect(encodedPayload).toContain(maskPii(REQUESTER_USER_ID))
    expect(encodedPayload).toContain(maskPii(TARGET_USER_ID))
    expect(encodedPayload).toContain(maskPii(STELLAR_ADDRESS))
    expect(encodedPayload).toContain(maskPii(EMAIL_ADDRESS))
    expectNoRawPii(encodedPayload)
  })
})
