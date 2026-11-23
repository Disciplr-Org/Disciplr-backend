import { beforeEach, describe, expect, it, jest } from '@jest/globals'
import type { S3Client } from '@aws-sdk/client-s3'
import {
  setS3ClientFactory,
  resetS3ClientFactory,
  uploadToS3,
  setPresigner,
  resetPresigner,
} from '../services/exportS3.js'

const mockSend = jest.fn<(...args: any[]) => any>()

function stubS3Client(): S3Client {
  return {
    send: mockSend,
    config: {
      requestHandler: { metadata: { handlerProtocol: 'h2' } },
      requestChecksumCalculation: jest.fn().mockResolvedValue('WHEN_SUPPORTED'),
      endpointProvider: jest.fn().mockResolvedValue({ url: new URL('https://s3.us-east-1.amazonaws.com') }),
      region: async () => 'us-east-1',
      credentials: async () => ({ accessKeyId: 'test-key', secretAccessKey: 'test-secret' }),
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
  } as unknown as S3Client
}

const config = { bucket: 'test-bucket', region: 'us-east-1', signedUrlTtlSeconds: 3600 }

function cmdName(cmd: unknown): string {
  return (cmd as any)?.constructor?.name ?? ''
}

beforeEach(() => {
  mockSend.mockClear()
  resetS3ClientFactory()
  resetPresigner()
  setS3ClientFactory(stubS3Client)
})

// ---------------------------------------------------------------------------
// Multipart upload lifecycle
// ---------------------------------------------------------------------------
describe('exportS3 multipart upload lifecycle', () => {
  // Force multipart (> 5 MB default part size)
  const LARGE = Buffer.alloc(6 * 1024 * 1024, 'x')
  const KEY = 'exports/job-1/export.csv'
  const CT = 'text/csv'

  // ------ abort on failure ---------------------------------------------------
  describe('abort on failure', () => {
    it('aborts multipart upload and rethrows when a part upload fails', async () => {
      const calls: string[] = []

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)
        calls.push(name)

        if (name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-1' }
        }
        if (name === 'UploadPartCommand') {
          throw new Error('Simulated part failure')
        }
        if (name === 'AbortMultipartUploadCommand') {
          expect(cmd.input.UploadId).toBe('upload-1')
          expect(cmd.input.Bucket).toBe(config.bucket)
          expect(cmd.input.Key).toBe(KEY)
          return {}
        }
        return {}
      })

      await expect(
        uploadToS3(config, KEY, LARGE, CT),
      ).rejects.toThrow('Simulated part failure')

      expect(calls).toContain('CreateMultipartUploadCommand')
      expect(calls).toContain('UploadPartCommand')
      expect(calls).toContain('AbortMultipartUploadCommand')
      expect(calls).not.toContain('CompleteMultipartUploadCommand')
    })

    it('calls abort exactly once after part failure (no orphaned uploads)', async () => {
      let abortCount = 0

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)

        if (name === 'CreateMultipartUploadCommand') {
          return { UploadId: 'upload-no-orphan' }
        }
        if (name === 'UploadPartCommand') {
          throw new Error('Part error')
        }
        if (name === 'AbortMultipartUploadCommand') {
          abortCount++
          return {}
        }
        return {}
      })

      await expect(
        uploadToS3(config, 'exports/job-2/export.csv', LARGE, CT),
      ).rejects.toThrow('Part error')

      expect(abortCount).toBe(1)
    })
  })

  // ------ part retry ---------------------------------------------------------
  describe('part retry', () => {
    it('retries a transient part failure and completes the upload', async () => {
      // Track retry attempts per part inside the mock send.
      const retries: Record<number, number[]> = {}
      let completed = false

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)
        const MAX = 2 // one retry after the initial attempt

        for (let attempt = 1; attempt <= MAX; attempt++) {
          try {
            if (name === 'CreateMultipartUploadCommand') {
              return { UploadId: 'upload-retry' }
            }

            if (name === 'UploadPartCommand') {
              const part = cmd.input.PartNumber as number
              ;(retries[part] ??= []).push(attempt)
              // Simulate transient failure for part 1 on first attempt
              if (part === 1 && attempt === 1) {
                throw new Error('Transient upload error')
              }
              return { ETag: `"part-${part}"` }
            }

            if (name === 'CompleteMultipartUploadCommand') {
              completed = true
              expect(cmd.input.Bucket).toBe(config.bucket)
              expect(cmd.input.Key).toBe(KEY)
              expect(cmd.input.UploadId).toBe('upload-retry')
              return {
                ETag: '"final"',
                Location: `https://s3.amazonaws.com/${config.bucket}/${KEY}`,
              }
            }

            if (name === 'AbortMultipartUploadCommand') {
              return {}
            }

            return {}
          } catch (e) {
            if (attempt === MAX) throw e
            // otherwise retry
          }
        }
      })

      await expect(
        uploadToS3(config, KEY, LARGE, CT),
      ).resolves.toBeUndefined()

      expect(completed).toBe(true)
      // Part 1 failed on first attempt then succeeded on retry
      expect(retries[1]).toEqual([1, 2])
      // Part 2 succeeded first time
      expect(retries[2]).toEqual([1])
    })

    it('aborts after repeated part failures exhaust retries', async () => {
      let aborted = false
      let completed = false

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)
        const MAX = 3

        for (let attempt = 1; attempt <= MAX; attempt++) {
          try {
            if (name === 'CreateMultipartUploadCommand') {
              return { UploadId: 'upload-exhaust' }
            }

            if (name === 'UploadPartCommand') {
              throw new Error('Persistent part error')
            }

            if (name === 'CompleteMultipartUploadCommand') {
              completed = true
              return {}
            }

            if (name === 'AbortMultipartUploadCommand') {
              aborted = true
              return {}
            }

            return {}
          } catch (e) {
            if (attempt === MAX) throw e
          }
        }
      })

      await expect(
        uploadToS3(config, KEY, LARGE, CT),
      ).rejects.toThrow('Persistent part error')

      expect(aborted).toBe(true)
      expect(completed).toBe(false)
    })
  })

  // ------ key guard enforcement ----------------------------------------------
  describe('key guard enforcement', () => {
    it('passes correct key, content-type, and content-disposition to S3', async () => {
      const captured: Array<{ name: string; input: any }> = []

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)

        if (name === 'CreateMultipartUploadCommand') {
          captured.push({ name, input: cmd.input })
          return { UploadId: 'upload-keyguard' }
        }

        if (name === 'UploadPartCommand') {
          captured.push({ name, input: { ...cmd.input, Body: '<elided>' } })
          return { ETag: `"part-${cmd.input.PartNumber}"` }
        }

        if (name === 'CompleteMultipartUploadCommand') {
          captured.push({
            name,
            input: { Bucket: cmd.input.Bucket, Key: cmd.input.Key, UploadId: cmd.input.UploadId },
          })
          return { ETag: '"final"', Location: 'https://s3.amazonaws.com/b/k' }
        }

        if (name === 'AbortMultipartUploadCommand') {
          return {}
        }

        return {}
      })

      await uploadToS3(config, KEY, LARGE, CT)

      const create = captured.find((c) => c.name === 'CreateMultipartUploadCommand')
      expect(create).toBeDefined()
      expect(create!.input.Bucket).toBe('test-bucket')
      expect(create!.input.Key).toBe(KEY)
      expect(create!.input.ContentType).toBe(CT)
      expect(create!.input.ContentDisposition).toBe(`attachment; filename="export.csv"`)

      const uploadPart = captured.find((c) => c.name === 'UploadPartCommand')
      expect(uploadPart).toBeDefined()
      expect(uploadPart!.input.Bucket).toBe('test-bucket')
      expect(uploadPart!.input.Key).toBe(KEY)
      expect(uploadPart!.input.UploadId).toBe('upload-keyguard')
      expect(uploadPart!.input.PartNumber).toBeGreaterThanOrEqual(1)

      const complete = captured.find((c) => c.name === 'CompleteMultipartUploadCommand')
      expect(complete).toBeDefined()
      expect(complete!.input.Bucket).toBe('test-bucket')
      expect(complete!.input.Key).toBe(KEY)
      expect(complete!.input.UploadId).toBe('upload-keyguard')
    })

    it('preserves key guards for a second, distinct object key', async () => {
      const secondKey = 'exports/admin-1/report.json'
      const inputs: any[] = []

      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)

        if (name === 'CreateMultipartUploadCommand') {
          inputs.push(cmd.input)
          return { UploadId: 'upload-keyguard-2' }
        }
        if (name === 'UploadPartCommand') {
          return { ETag: `"part-${cmd.input.PartNumber}"` }
        }
        if (name === 'CompleteMultipartUploadCommand') {
          return { ETag: '"final"', Location: 'https://s3.amazonaws.com/b/k' }
        }
        return {}
      })

      await uploadToS3(config, secondKey, LARGE, 'application/json')

      expect(inputs[0].Key).toBe(secondKey)
      expect(inputs[0].ContentType).toBe('application/json')
      expect(inputs[0].ContentDisposition).toBe('attachment; filename="report.json"')
    })
  })

  // ------ empty payload ------------------------------------------------------
  describe('empty payload', () => {
    it('handles an empty buffer without throwing', async () => {
      mockSend.mockImplementation(async (cmd: any) => {
        const name = cmdName(cmd)
        if (name === 'CreateMultipartUploadCommand' || name === 'PutObjectCommand') {
          return { ETag: '""' }
        }
        if (name === 'CompleteMultipartUploadCommand') {
          return { ETag: '""', Location: 'https://s3.amazonaws.com/b/k' }
        }
        return {}
      })

      await expect(
        uploadToS3(config, 'exports/job-empty/empty.csv', Buffer.alloc(0), 'text/csv'),
      ).resolves.toBeUndefined()
    })
  })
})
