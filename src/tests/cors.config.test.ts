import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import type { CorsOptions } from 'cors'

type OriginResolver = (
  origin: string | undefined,
  callback: (error: Error | null, allow?: boolean) => void,
) => void

const originalEnv = { ...process.env }

const loadCorsOptions = async (
  corsOrigins: string | undefined,
  nodeEnv = 'test',
): Promise<CorsOptions> => {
  jest.resetModules()
  process.env.NODE_ENV = nodeEnv
  if (corsOrigins === undefined) delete process.env.CORS_ORIGINS
  else process.env.CORS_ORIGINS = corsOrigins
  const { corsOptions } = await import('../config/cors.js')
  return corsOptions
}

const resolveOrigin = (
  options: CorsOptions,
  origin: string | undefined,
): Promise<boolean | undefined> =>
  new Promise((resolve, reject) => {
    const resolver = options.origin as OriginResolver
    if (typeof resolver !== 'function') {
      reject(new Error('corsOptions.origin must be a custom resolver'))
      return
    }
    resolver(origin, (error, allow) => {
      if (error) reject(error)
      else resolve(allow)
    })
  })

const loggedEvents = (logSpy: ReturnType<typeof jest.spyOn>) =>
  logSpy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)

describe('src/config/cors.ts — corsOptions', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
    jest.resetModules()
    process.env = { ...originalEnv }
  })

  describe('allowlist happy path', () => {
    it('allows a configured origin and enables credentials', async () => {
      const options = await loadCorsOptions(
        'https://app.example.com,https://admin.example.com',
      )

      await expect(resolveOrigin(options, 'https://app.example.com')).resolves.toBe(true)
      await expect(resolveOrigin(options, 'https://admin.example.com')).resolves.toBe(true)
      expect(options.credentials).toBe(true)
    })

    it('normalizes trailing slashes and casing on both sides', async () => {
      const options = await loadCorsOptions('https://APP.example.com/')

      await expect(resolveOrigin(options, 'https://app.example.com///')).resolves.toBe(true)
    })

    it('allows server-to-server requests with no Origin header', async () => {
      const options = await loadCorsOptions('https://app.example.com')

      await expect(resolveOrigin(options, undefined)).resolves.toBe(true)
    })

    it('exposes the expected methods and allowed headers', async () => {
      const options = await loadCorsOptions('https://app.example.com')

      expect(options.methods).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'PATCH'])
      expect(options.allowedHeaders).toEqual([
        'Content-Type',
        'Authorization',
        'idempotency-key',
      ])
    })
  })

  describe('failure modes', () => {
    it('rejects the null origin and emits a security rejection event', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const options = await loadCorsOptions('*')

      await expect(resolveOrigin(options, 'null')).resolves.toBe(false)
      expect(loggedEvents(logSpy)).toEqual([
        expect.objectContaining({
          level: 'warn',
          event: 'security.cors_rejected',
          origin: 'null',
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      ])
    })

    it('rejects an origin that is not in the allowlist and logs it', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const options = await loadCorsOptions('https://app.example.com')

      await expect(resolveOrigin(options, 'https://evil.example')).resolves.toBe(false)
      expect(loggedEvents(logSpy)).toEqual([
        expect.objectContaining({
          level: 'warn',
          event: 'security.cors_rejected',
          origin: 'https://evil.example',
          timestamp: '2026-01-01T00:00:00.000Z',
        }),
      ])
    })

    it('blocks every cross-origin request when production has no allowlist', async () => {
      jest.spyOn(console, 'warn').mockImplementation(() => {})
      jest.spyOn(console, 'log').mockImplementation(() => {})
      const options = await loadCorsOptions(undefined, 'production')

      await expect(resolveOrigin(options, 'https://app.example.com')).resolves.toBe(false)
      await expect(resolveOrigin(options, undefined)).resolves.toBe(true)
      expect(options.credentials).toBe(true)
    })
  })

  describe('wildcard configuration', () => {
    it('allows arbitrary origins but disables credentials', async () => {
      const options = await loadCorsOptions('*')

      await expect(resolveOrigin(options, 'https://untrusted.example')).resolves.toBe(true)
      expect(options.credentials).toBe(false)
    })

    it('still blocks the null origin when wildcard is configured', async () => {
      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
      const options = await loadCorsOptions('*')

      await expect(resolveOrigin(options, 'null')).resolves.toBe(false)
      expect(loggedEvents(logSpy)).toHaveLength(1)
    })

    it('does not treat a wildcard inside a list as a wildcard', async () => {
      jest.spyOn(console, 'log').mockImplementation(() => {})
      const options = await loadCorsOptions('https://app.example.com,*')

      await expect(resolveOrigin(options, 'https://evil.example')).resolves.toBe(false)
      await expect(resolveOrigin(options, 'https://app.example.com')).resolves.toBe(true)
      expect(options.credentials).toBe(true)
    })
  })
})
