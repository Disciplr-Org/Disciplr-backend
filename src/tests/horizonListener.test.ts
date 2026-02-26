import { HorizonListener } from '../services/horizonListener'
import { EventProcessor } from '../services/eventProcessor'
import { HorizonListenerConfig } from '../config/horizonListener'
import { Knex } from 'knex'
import { jest } from '@jest/globals'

describe('HorizonListener', () => {
  let mockDb: any
  let mockEventProcessor: any
  let config: HorizonListenerConfig

  beforeEach(() => {
    // Mock database query builder for listener_state
    const mockQueryBuilder: any = {
      where: jest.fn<any>().mockReturnThis(),
      first: jest.fn<any>().mockResolvedValue(null),
      insert: jest.fn<any>().mockReturnThis(),
      onConflict: jest.fn<any>().mockReturnThis(),
      merge: jest.fn<any>().mockResolvedValue(undefined),
    }
    
    // Create a callable function that returns the query builder
    const dbCallable: any = jest.fn<any>().mockReturnValue(mockQueryBuilder)
    
    // Mock database
    mockDb = Object.assign(dbCallable, {
      raw: jest.fn<any>().mockResolvedValue(undefined),
      transaction: jest.fn<any>(),
      destroy: jest.fn<any>().mockResolvedValue(undefined),
    })

    // Mock EventProcessor
    mockEventProcessor = {
      processEvent: jest.fn<any>().mockResolvedValue({ success: true, eventId: 'test-event' }),
    }

    // Test configuration
    config = {
      horizonUrl: 'https://horizon-testnet.stellar.org',
      contractAddresses: ['CTEST123'],
      startLedger: 1000,
      retryMaxAttempts: 3,
      retryBackoffMs: 100,
      shutdownTimeoutMs: 30000,
    }
  })

  describe('constructor', () => {
    it('should create a HorizonListener instance', () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      expect(listener).toBeInstanceOf(HorizonListener)
    })
  })

  describe('isRunning', () => {
    it('should return false initially', () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      expect(listener.isRunning()).toBe(false)
    })
  })

  describe('start', () => {
    it('should set running state to true', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      
      // Start in background (don't await)
      const startPromise = listener.start()
      
      // Give it a moment to initialize
      await new Promise(resolve => setTimeout(resolve, 100))
      
      expect(listener.isRunning()).toBe(true)
      
      // Clean up
      await listener.stop()
      await startPromise
    })
  })

  describe('stop', () => {
    it('should set running state to false', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      
      // Start and then stop
      const startPromise = listener.start()
      await new Promise(resolve => setTimeout(resolve, 100))
      
      await listener.stop()
      
      expect(listener.isRunning()).toBe(false)
      
      await startPromise
    })

    it('should not throw if called when not running', async () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      
      await expect(listener.stop()).resolves.not.toThrow()
    })
  })

  describe('configuration', () => {
    it('should accept valid configuration', () => {
      const listener = new HorizonListener(config, mockEventProcessor, mockDb)
      expect(listener).toBeDefined()
    })

    it('should handle multiple contract addresses', () => {
      const multiConfig = {
        ...config,
        contractAddresses: ['CTEST1', 'CTEST2', 'CTEST3'],
      }
      const listener = new HorizonListener(multiConfig, mockEventProcessor, mockDb)
      expect(listener).toBeDefined()
    })
  })
})
