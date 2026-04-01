import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { validateEnv, envSchema } from '../config/env.js'
import { initEnv, getEnv, _resetEnvForTesting } from '../config/index.js'

/** Minimal valid env record — every required field present. */
const validEnv: Record<string, string> = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/disciplr',
}

describe('envSchema', () => {
  it('should accept a minimal valid env with only DATABASE_URL', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
  })

  it('should apply correct defaults for optional fields', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (!result.success) return

    const env = result.data
    expect(env.NODE_ENV).toBe('development')
    expect(env.PORT).toBe(3000)
    expect(env.SERVICE_NAME).toBe('disciplr-backend')
    expect(env.JWT_SECRET).toBe('change-me-in-production')
    expect(env.JWT_ACCESS_SECRET).toBe('fallback-access-secret')
    expect(env.JWT_REFRESH_SECRET).toBe('fallback-refresh-secret')
    expect(env.JWT_ACCESS_EXPIRES_IN).toBe('15m')
    expect(env.JWT_REFRESH_EXPIRES_IN).toBe('7d')
    expect(env.DOWNLOAD_SECRET).toBe('change-me-in-production')
    expect(env.RETRY_MAX_ATTEMPTS).toBe(3)
    expect(env.RETRY_BACKOFF_MS).toBe(100)
    expect(env.JOB_WORKER_CONCURRENCY).toBe(2)
    expect(env.JOB_QUEUE_POLL_INTERVAL_MS).toBe(250)
    expect(env.JOB_HISTORY_LIMIT).toBe(50)
    expect(env.ETL_INTERVAL_MINUTES).toBe(5)
  })

  it('should reject when DATABASE_URL is missing', () => {
    const result = envSchema.safeParse({})
    expect(result.success).toBe(false)
  })

  it('should reject when DATABASE_URL is an empty string', () => {
    const result = envSchema.safeParse({ DATABASE_URL: '' })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid NODE_ENV value', () => {
    const result = envSchema.safeParse({ ...validEnv, NODE_ENV: 'staging' })
    expect(result.success).toBe(false)
  })

  it('should accept valid NODE_ENV values', () => {
    for (const env of ['development', 'production', 'test']) {
      const result = envSchema.safeParse({ ...validEnv, NODE_ENV: env })
      expect(result.success).toBe(true)
    }
  })

  it('should coerce PORT from string to number', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: '8080' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(8080)
    }
  })

  it('should fall back to default when PORT is not a valid number', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: 'abc' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
    }
  })

  it('should fall back to default when PORT is zero or negative', () => {
    for (const val of ['0', '-1']) {
      const result = envSchema.safeParse({ ...validEnv, PORT: val })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.PORT).toBe(3000)
      }
    }
  })

  it('should fall back to default when PORT is empty string', () => {
    const result = envSchema.safeParse({ ...validEnv, PORT: '' })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.PORT).toBe(3000)
    }
  })

  it('should coerce JOB_WORKER_CONCURRENCY from string', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      JOB_WORKER_CONCURRENCY: '4',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.JOB_WORKER_CONCURRENCY).toBe(4)
    }
  })

  it('should fall back to default for non-numeric JOB_WORKER_CONCURRENCY', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      JOB_WORKER_CONCURRENCY: 'not-a-number',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.JOB_WORKER_CONCURRENCY).toBe(2)
    }
  })

  it('should coerce RETRY_MAX_ATTEMPTS as non-negative int', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      RETRY_MAX_ATTEMPTS: '0',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.RETRY_MAX_ATTEMPTS).toBe(0)
    }
  })

  it('should fall back for negative RETRY_MAX_ATTEMPTS', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      RETRY_MAX_ATTEMPTS: '-5',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.RETRY_MAX_ATTEMPTS).toBe(3)
    }
  })

  it('should leave optional string fields as undefined when absent', () => {
    const result = envSchema.safeParse(validEnv)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CORS_ORIGINS).toBeUndefined()
      expect(result.data.HORIZON_URL).toBeUndefined()
      expect(result.data.CONTRACT_ADDRESS).toBeUndefined()
      expect(result.data.SOROBAN_CONTRACT_ID).toBeUndefined()
    }
  })

  it('should preserve explicit string values for optional fields', () => {
    const result = envSchema.safeParse({
      ...validEnv,
      CORS_ORIGINS: 'https://app.example.com',
      HORIZON_URL: 'https://horizon.stellar.org',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.CORS_ORIGINS).toBe('https://app.example.com')
      expect(result.data.HORIZON_URL).toBe('https://horizon.stellar.org')
    }
  })
})

describe('validateEnv', () => {
  let mockExit: ReturnType<typeof jest.spyOn>
  let mockConsoleError: ReturnType<typeof jest.spyOn>
  let mockConsoleWarn: ReturnType<typeof jest.spyOn>

  beforeEach(() => {
    mockExit = jest.spyOn(process, 'exit').mockImplementation(
      (code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      },
    )
    mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockConsoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    mockExit.mockRestore()
    mockConsoleError.mockRestore()
    mockConsoleWarn.mockRestore()
  })

  it('should return validated env on valid input', () => {
    const { env, warnings } = validateEnv(validEnv)

    expect(env.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/disciplr')
    expect(env.NODE_ENV).toBe('development')
    expect(warnings).toHaveLength(0)
  })

  it('should exit with code 1 when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')
    expect(mockConsoleError).toHaveBeenCalledTimes(1)

    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    const parsed = JSON.parse(loggedArg)
    expect(parsed.level).toBe('fatal')
    expect(parsed.event).toBe('config.env_validation_failed')
  })

  it('should not leak sensitive env values in error output', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')
    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    expect(loggedArg).not.toContain('postgres://')
    expect(loggedArg).not.toContain('secret')
  })

  it('should exit with code 1 when DATABASE_URL is empty', () => {
    expect(() => validateEnv({ DATABASE_URL: '' })).toThrow('process.exit: 1')
  })

  it('should exit with code 1 for invalid NODE_ENV', () => {
    expect(() =>
      validateEnv({ ...validEnv, NODE_ENV: 'invalid' }),
    ).toThrow('process.exit: 1')
  })

  it('should emit structured JSON error log on failure', () => {
    expect(() => validateEnv({})).toThrow('process.exit: 1')

    expect(mockConsoleError).toHaveBeenCalledTimes(1)
    const loggedArg = (mockConsoleError.mock.calls[0] as string[])[0]
    const parsed = JSON.parse(loggedArg)

    expect(parsed).toMatchObject({
      level: 'fatal',
      event: 'config.env_validation_failed',
      service: 'disciplr-backend',
    })
    expect(parsed.errors).toBeInstanceOf(Array)
    expect(parsed.errors.length).toBeGreaterThan(0)
    expect(parsed.timestamp).toBeDefined()
  })

  describe('production secret warnings', () => {
    const prodEnv: Record<string, string> = {
      ...validEnv,
      NODE_ENV: 'production',
    }

    it('should warn about insecure JWT_SECRET default in production', () => {
      const { warnings } = validateEnv(prodEnv)

      const jwtWarning = warnings.find((w) => w.variable === 'JWT_SECRET')
      expect(jwtWarning).toBeDefined()
      expect(jwtWarning!.message).toContain('insecure default')
      expect(mockConsoleWarn).toHaveBeenCalled()
    })

    it('should warn about all insecure defaults in production', () => {
      const { warnings } = validateEnv(prodEnv)

      const warnedVars = warnings.map((w) => w.variable)
      expect(warnedVars).toContain('JWT_SECRET')
      expect(warnedVars).toContain('JWT_ACCESS_SECRET')
      expect(warnedVars).toContain('JWT_REFRESH_SECRET')
      expect(warnedVars).toContain('DOWNLOAD_SECRET')
    })

    it('should not warn when secrets are explicitly set in production', () => {
      const { warnings } = validateEnv({
        ...prodEnv,
        JWT_SECRET: 'super-secret-production-key',
        JWT_ACCESS_SECRET: 'prod-access-secret',
        JWT_REFRESH_SECRET: 'prod-refresh-secret',
        DOWNLOAD_SECRET: 'prod-download-secret',
      })

      expect(warnings).toHaveLength(0)
      expect(mockConsoleWarn).not.toHaveBeenCalled()
    })

    it('should not warn about secrets in development mode', () => {
      const { warnings } = validateEnv(validEnv)
      expect(warnings).toHaveLength(0)
    })

    it('should emit structured JSON warn log per insecure secret', () => {
      validateEnv(prodEnv)

      const warnCalls = mockConsoleWarn.mock.calls
      expect(warnCalls.length).toBe(4)

      for (const call of warnCalls) {
        const parsed = JSON.parse(call[0] as string)
        expect(parsed.level).toBe('warn')
        expect(parsed.event).toBe('config.insecure_default')
        expect(parsed.service).toBe('disciplr-backend')
        expect(parsed.variable).toBeDefined()
      }
    })
  })
})

describe('initEnv / getEnv', () => {
  const originalEnv = process.env

  beforeEach(() => {
    _resetEnvForTesting()
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'postgres://test@localhost/test',
    }
  })

  afterEach(() => {
    _resetEnvForTesting()
    process.env = originalEnv
  })

  it('should populate getEnv after initEnv is called', () => {
    initEnv()
    const env = getEnv()
    expect(env.DATABASE_URL).toBe('postgres://test@localhost/test')
  })

  it('should throw if getEnv is called before initEnv', () => {
    expect(() => getEnv()).toThrow('Environment not validated yet')
  })

  it('should be idempotent — second call returns same result', () => {
    const first = initEnv()
    const second = initEnv()
    expect(first.env).toBe(second.env)
  })

  it('should accept a custom env record override', () => {
    const { env } = initEnv({
      DATABASE_URL: 'postgres://custom@localhost/custom',
    })
    expect(env.DATABASE_URL).toBe('postgres://custom@localhost/custom')
  })
})
