import { jest } from '@jest/globals'
import type { NextFunction, Request, Response } from 'express'

const mockEnv: any = {
  LOG_SAMPLE_RATE: 1,
  LOG_SLOW_THRESHOLD_MS: 1000,
  LOG_ALWAYS_LOG_STATUS: '500,502,503',
  ADMIN_API_KEY: 'test-admin-key',
}

jest.unstable_mockModule('../config/env.js', () => ({
  getEnv: jest.fn(() => mockEnv),
}))

const { requestLogger } = await import('../middleware/requestLogger.js')
import * as loggerModule from '../middleware/logger.js'

function mockRes() {
  let finishHandler: () => void = () => {}
  return {
    statusCode: 200,
    getHeaders: () => ({}),
    on: ((event: string, handler: () => void) => {
      if (event === 'finish') finishHandler = handler
      return mockRes() as Response
    }) as any,
    emitFinish() {
      finishHandler()
    },
  }
}

describe('requestLogger sampling', () => {
  let req: Partial<Request>
  let res: any
  let next: NextFunction
  let mockLogger: any

  beforeEach(() => {
    jest.clearAllMocks()

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }

    jest.spyOn(loggerModule.logger, 'child').mockReturnValue(mockLogger as any)

    req = {
      method: 'GET',
      originalUrl: '/api/test',
      path: '/api/test',
      url: '/api/test',
      headers: {},
      body: {},
      socket: {} as any,
    }
    res = mockRes()
    next = jest.fn()

    mockEnv.LOG_SAMPLE_RATE = 1
    mockEnv.LOG_SLOW_THRESHOLD_MS = 1000
    mockEnv.LOG_ALWAYS_LOG_STATUS = '500,502,503'
    mockEnv.ADMIN_API_KEY = 'test-admin-key'
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('basic logging', () => {
    it('logs at info level for 2xx responses', () => {
      res.statusCode = 200
      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('logs at warn level for 4xx responses', () => {
      res.statusCode = 404
      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it('logs at error level for 5xx responses', () => {
      res.statusCode = 500
      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('logs at debug level for other status codes', () => {
      res.statusCode = 100
      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.debug).toHaveBeenCalled()
    })

    it('always calls next()', () => {
      requestLogger(req as Request, res as Response, next)
      expect(next).toHaveBeenCalledTimes(1)
    })
  })

  describe('tail-based sampling', () => {
    it('logs when sampled in (Math.random < rate)', () => {
      mockEnv.LOG_SAMPLE_RATE = 0.5
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'
      jest.spyOn(Math, 'random').mockReturnValue(0.3)

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalledTimes(1)
    })

    it('skips logging when sampled out (Math.random >= rate)', () => {
      mockEnv.LOG_SAMPLE_RATE = 0.5
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'
      jest.spyOn(Math, 'random').mockReturnValue(0.7)

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).not.toHaveBeenCalled()
    })

    it('always logs 5xx errors regardless of sample rate', () => {
      mockEnv.LOG_SAMPLE_RATE = 0
      jest.spyOn(Math, 'random').mockReturnValue(0.9)
      res.statusCode = 500

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('always logs requests exceeding slow threshold', () => {
      mockEnv.LOG_SAMPLE_RATE = 0
      mockEnv.LOG_SLOW_THRESHOLD_MS = 10
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'
      jest.spyOn(Math, 'random').mockReturnValue(0.9)

      const realNow = Date.now
      let callCount = 0
      Date.now = () => (callCount++ === 0 ? 0 : 100)

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      Date.now = realNow

      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('always logs statuses in LOG_ALWAYS_LOG_STATUS', () => {
      mockEnv.LOG_SAMPLE_RATE = 0
      mockEnv.LOG_ALWAYS_LOG_STATUS = '503,504'
      jest.spyOn(Math, 'random').mockReturnValue(0.9)
      res.statusCode = 503

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.error).toHaveBeenCalled()
    })

    it('logs everything when sample rate is 1', () => {
      mockEnv.LOG_SAMPLE_RATE = 1
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('only logs important requests when sample rate is 0', () => {
      mockEnv.LOG_SAMPLE_RATE = 0
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'
      jest.spyOn(Math, 'random').mockReturnValue(0.9)

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).not.toHaveBeenCalled()
    })
  })

  describe('admin debug overrides', () => {
    it('forces debug level via x-debug-trace header', () => {
      req.headers = { 'x-debug-trace': 'test-admin-key' }

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.debug).toHaveBeenCalled()
      expect(mockLogger.info).not.toHaveBeenCalled()
    })

    it('ignores x-debug-trace with wrong key', () => {
      req.headers = { 'x-debug-trace': 'wrong-key' }

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
      expect(mockLogger.debug).not.toHaveBeenCalled()
    })

    it('overrides log level via x-log-level with x-admin-key auth', () => {
      req.headers = {
        'x-log-level': 'warn',
        'x-admin-key': 'test-admin-key',
      }
      res.statusCode = 200

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.warn).toHaveBeenCalled()
      expect(mockLogger.info).not.toHaveBeenCalled()
    })

    it('ignores x-log-level without matching x-admin-key', () => {
      req.headers = {
        'x-log-level': 'warn',
        'x-admin-key': 'wrong-key',
      }
      res.statusCode = 200

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
      expect(mockLogger.warn).not.toHaveBeenCalled()
    })

    it('ignores x-log-level with invalid level value', () => {
      req.headers = {
        'x-log-level': 'invalid-level',
        'x-admin-key': 'test-admin-key',
      }
      res.statusCode = 200

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
    })

    it('disables admin overrides when ADMIN_API_KEY is empty', () => {
      mockEnv.ADMIN_API_KEY = ''
      req.headers = { 'x-debug-trace': '' }

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.info).toHaveBeenCalled()
      expect(mockLogger.debug).not.toHaveBeenCalled()
    })

    it('x-debug-trace overrides sampling (force logs even when sampled out)', () => {
      mockEnv.LOG_SAMPLE_RATE = 0
      mockEnv.LOG_ALWAYS_LOG_STATUS = '999'
      jest.spyOn(Math, 'random').mockReturnValue(0.9)
      req.headers = { 'x-debug-trace': 'test-admin-key' }

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()
      expect(mockLogger.debug).toHaveBeenCalled()
    })
  })

  describe('correlation ID and regression', () => {
    it('preserves correlation ID on request', () => {
      req.headers = { 'x-correlation-id': 'test-corr-id' }

      requestLogger(req as Request, res as Response, next)

      expect((req as any).correlationId).toBe('test-corr-id')
    })

    it('generates correlation ID when header is missing', () => {
      requestLogger(req as Request, res as Response, next)

      expect((req as any).correlationId).toBeDefined()
      expect(typeof (req as any).correlationId).toBe('string')
    })

    it('attaches logger to request for downstream handlers', () => {
      requestLogger(req as Request, res as Response, next)

      expect((req as any).logger).toBeDefined()
    })
  })

  describe('structured log content', () => {
    it('includes expected fields in the log object', () => {
      req.method = 'POST'
      req.path = '/api/vaults/123'
      req.headers = { 'x-user-id': 'user-1', 'x-user-role': 'admin' }
      req.body = { name: 'test' }

      requestLogger(req as Request, res as Response, next)
      res.emitFinish()

      const logArg = mockLogger.info.mock.calls[0][0]
      expect(logArg.event).toBe('http.request')
      expect(logArg.req.method).toBe('POST')
      expect(logArg.req.path).toBe('/api/vaults/123')
      expect(logArg.req.userId).toBe('user-1')
      expect(logArg.req.userRole).toBe('admin')
      expect(logArg.res.statusCode).toBe(200)
      expect(logArg.durationMs).toEqual(expect.any(Number))
    })
  })
})
