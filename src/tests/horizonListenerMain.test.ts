import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import type { Knex } from 'knex'
import { main, HorizonListenerMainDeps } from '../services/horizonListenerMain.js'
import defaultMain from '../services/horizonListenerMain.js'
import { HorizonListenerConfig, HorizonListenerConfigError } from '../config/horizonListener.js'
import type { CheckpointStore } from '../services/checkpointStore.js'
import type { EventProcessor } from '../services/eventProcessor.js'

describe('horizonListenerMain bootstrap', () => {
  let mockDb: Knex
  let mockRaw: jest.Mock
  let mockGetValidatedConfig: jest.Mock<() => HorizonListenerConfig>
  let mockCheckpointStoreInstance: CheckpointStore
  let mockCheckpointStoreClass: NonNullable<HorizonListenerMainDeps['CheckpointStoreClass']>
  let mockEventProcessorInstance: EventProcessor
  let mockEventProcessorClass: NonNullable<HorizonListenerMainDeps['EventProcessorClass']>
  let mockHorizonListenerInstance: { start: jest.Mock }
  let mockHorizonListenerClass: NonNullable<HorizonListenerMainDeps['HorizonListenerClass']>
  let mockExit: jest.Mock<(code?: number) => void>
  let mockLogger: {
    log: jest.Mock<(...args: unknown[]) => void>
    error: jest.Mock<(...args: unknown[]) => void>
  }
  let baseConfig: HorizonListenerConfig

  beforeEach(() => {
    jest.useFakeTimers()

    baseConfig = {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      contractAddresses: ['CAAA123', 'CBBB456'],
      startLedger: 1000,
      retryMaxAttempts: 5,
      retryBackoffMs: 250,
      shutdownTimeoutMs: 30000,
      lagThreshold: 50,
    }

    mockRaw = jest.fn().mockResolvedValue(undefined)
    mockDb = {
      raw: mockRaw,
    } as unknown as Knex

    mockGetValidatedConfig = jest.fn<() => HorizonListenerConfig>().mockReturnValue(baseConfig)

    mockCheckpointStoreInstance = {} as unknown as CheckpointStore
    mockCheckpointStoreClass = jest
      .fn()
      .mockImplementation(() => mockCheckpointStoreInstance) as unknown as NonNullable<
      HorizonListenerMainDeps['CheckpointStoreClass']
    >

    mockEventProcessorInstance = {} as unknown as EventProcessor
    mockEventProcessorClass = jest
      .fn()
      .mockImplementation(() => mockEventProcessorInstance) as unknown as NonNullable<
      HorizonListenerMainDeps['EventProcessorClass']
    >

    mockHorizonListenerInstance = {
      start: jest.fn().mockResolvedValue(undefined),
    }
    mockHorizonListenerClass = jest
      .fn()
      .mockImplementation(() => mockHorizonListenerInstance) as unknown as NonNullable<
      HorizonListenerMainDeps['HorizonListenerClass']
    >

    mockExit = jest.fn<(code?: number) => void>()

    mockLogger = {
      log: jest.fn<(...args: unknown[]) => void>(),
      error: jest.fn<(...args: unknown[]) => void>(),
    }
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  describe('exports', () => {
    it('should export main as a function and as default export', () => {
      expect(typeof main).toBe('function')
      expect(typeof defaultMain).toBe('function')
      expect(main).toBe(defaultMain)
    })
  })

  describe('happy path', () => {
    it('should initialise all dependencies and start the listener', async () => {
      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        CheckpointStoreClass: mockCheckpointStoreClass,
        EventProcessorClass: mockEventProcessorClass,
        HorizonListenerClass: mockHorizonListenerClass,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      // 1. Validated config loaded
      expect(mockGetValidatedConfig).toHaveBeenCalledTimes(1)

      // 2. Database ping executed
      expect(mockRaw).toHaveBeenCalledWith('SELECT 1')

      // 3. Checkpoint store instantiated with db
      expect(mockCheckpointStoreClass).toHaveBeenCalledWith(mockDb)

      // 4. Event processor instantiated with db and processor config
      expect(mockEventProcessorClass).toHaveBeenCalledWith(mockDb, {
        maxRetries: 5,
        retryBackoffMs: 250,
      })

      // 5. Horizon listener instantiated with config, processor, db, and store
      expect(mockHorizonListenerClass).toHaveBeenCalledWith(
        baseConfig,
        mockEventProcessorInstance,
        mockDb,
        mockCheckpointStoreInstance,
      )

      // 6. Horizon listener start called
      expect(mockHorizonListenerInstance.start).toHaveBeenCalledTimes(1)

      // 7. Exit not called on happy path
      expect(mockExit).not.toHaveBeenCalled()

      // 8. Expected log events emitted
      const loggedMessages = mockLogger.log.mock.calls.map(
        (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
      )
      const events = loggedMessages.map((msg) => msg['event'])
      expect(events).toEqual([
        'horizon.startup',
        'horizon.config_loaded',
        'horizon.db_connected',
        'horizon.listener_starting',
        'horizon.listener_running',
      ])
    })

    it('should log from_checkpoint when startLedger is undefined', async () => {
      const configWithoutStartLedger: HorizonListenerConfig = {
        ...baseConfig,
        startLedger: undefined,
      }
      mockGetValidatedConfig.mockReturnValue(configWithoutStartLedger)

      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        CheckpointStoreClass: mockCheckpointStoreClass,
        EventProcessorClass: mockEventProcessorClass,
        HorizonListenerClass: mockHorizonListenerClass,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      expect(mockHorizonListenerInstance.start).toHaveBeenCalledTimes(1)
      expect(mockExit).not.toHaveBeenCalled()

      const loggedMessages = mockLogger.log.mock.calls.map(
        (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
      )
      const configLoadedLog = loggedMessages.find((msg) => msg['event'] === 'horizon.config_loaded')
      expect(configLoadedLog?.['startLedger']).toBe('from_checkpoint')
    })
  })

  describe('failure modes', () => {
    it('should handle configuration failure and exit with code 1', async () => {
      const configError = new HorizonListenerConfigError('Invalid HORIZON_URL', ['HORIZON_URL is missing'])
      mockGetValidatedConfig.mockImplementation(() => {
        throw configError
      })

      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        CheckpointStoreClass: mockCheckpointStoreClass,
        EventProcessorClass: mockEventProcessorClass,
        HorizonListenerClass: mockHorizonListenerClass,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockRaw).not.toHaveBeenCalled()
      expect(mockHorizonListenerClass).not.toHaveBeenCalled()

      expect(mockLogger.error).toHaveBeenCalledTimes(1)
      const errorLog = JSON.parse(mockLogger.error.mock.calls[0][0] as string) as Record<string, unknown>
      expect(errorLog['level']).toBe('fatal')
      expect(errorLog['event']).toBe('horizon.startup_failed')
      expect(errorLog['error']).toBe('Invalid HORIZON_URL')
    })

    it('should handle database connection failure and exit with code 1', async () => {
      const dbError = new Error('Database connection refused')
      mockRaw.mockRejectedValue(dbError)

      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        CheckpointStoreClass: mockCheckpointStoreClass,
        EventProcessorClass: mockEventProcessorClass,
        HorizonListenerClass: mockHorizonListenerClass,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      expect(mockRaw).toHaveBeenCalledWith('SELECT 1')
      expect(mockCheckpointStoreClass).not.toHaveBeenCalled()
      expect(mockHorizonListenerClass).not.toHaveBeenCalled()
      expect(mockExit).toHaveBeenCalledWith(1)

      expect(mockLogger.error).toHaveBeenCalledTimes(1)
      const errorLog = JSON.parse(mockLogger.error.mock.calls[0][0] as string) as Record<string, unknown>
      expect(errorLog['level']).toBe('fatal')
      expect(errorLog['event']).toBe('horizon.startup_failed')
      expect(errorLog['error']).toBe('Database connection refused')
    })

    it('should handle listener start failure and exit with code 1', async () => {
      const startError = new Error('Failed to connect to Horizon SSE stream')
      mockHorizonListenerInstance.start.mockRejectedValue(startError)

      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        CheckpointStoreClass: mockCheckpointStoreClass,
        EventProcessorClass: mockEventProcessorClass,
        HorizonListenerClass: mockHorizonListenerClass,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      expect(mockHorizonListenerInstance.start).toHaveBeenCalledTimes(1)
      expect(mockExit).toHaveBeenCalledWith(1)

      expect(mockLogger.error).toHaveBeenCalledTimes(1)
      const errorLog = JSON.parse(mockLogger.error.mock.calls[0][0] as string) as Record<string, unknown>
      expect(errorLog['level']).toBe('fatal')
      expect(errorLog['event']).toBe('horizon.startup_failed')
      expect(errorLog['error']).toBe('Failed to connect to Horizon SSE stream')
    })

    it('should handle non-Error thrown objects gracefully and exit with code 1', async () => {
      mockGetValidatedConfig.mockImplementation(() => {
        throw 'Unexpected string rejection'
      })

      const deps: HorizonListenerMainDeps = {
        db: mockDb,
        getValidatedConfig: mockGetValidatedConfig,
        exit: mockExit,
        logger: mockLogger,
      }

      await main(deps)

      expect(mockExit).toHaveBeenCalledWith(1)
      expect(mockLogger.error).toHaveBeenCalledTimes(1)
      const errorLog = JSON.parse(mockLogger.error.mock.calls[0][0] as string) as Record<string, unknown>
      expect(errorLog['level']).toBe('fatal')
      expect(errorLog['event']).toBe('horizon.startup_failed')
      expect(errorLog['error']).toBe('Unexpected string rejection')
    })
  })
})
