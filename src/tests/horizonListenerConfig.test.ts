/**
 * Tests for Horizon Listener configuration loader
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { loadHorizonListenerConfig, validateHorizonListenerConfig, getValidatedConfig } from '../config/horizonListener.js'

describe('Horizon Listener Configuration', () => {
  const originalEnv = process.env

  beforeEach(() => {
    // Reset environment before each test
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv
  })

  describe('loadHorizonListenerConfig', () => {
    it('should load all configuration from environment variables', () => {
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org'
      process.env.CONTRACT_ADDRESS = 'CDISCIPLR1,CDISCIPLR2'
      process.env.START_LEDGER = '12345'
      process.env.RETRY_MAX_ATTEMPTS = '5'
      process.env.RETRY_BACKOFF_MS = '200'

      const config = loadHorizonListenerConfig()

      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org')
      expect(config.contractAddresses).toEqual(['CDISCIPLR1', 'CDISCIPLR2'])
      expect(config.startLedger).toBe(12345)
      expect(config.retryMaxAttempts).toBe(5)
      expect(config.retryBackoffMs).toBe(200)
      expect(config.shutdownTimeoutMs).toBe(30000)
    })

    it('should parse CONTRACT_ADDRESS as comma-separated list', () => {
      process.env.CONTRACT_ADDRESS = 'ADDR1, ADDR2 , ADDR3'

      const config = loadHorizonListenerConfig()

      expect(config.contractAddresses).toEqual(['ADDR1', 'ADDR2', 'ADDR3'])
    })

    it('should filter out empty addresses from CONTRACT_ADDRESS', () => {
      process.env.CONTRACT_ADDRESS = 'ADDR1,,ADDR2, ,ADDR3'

      const config = loadHorizonListenerConfig()

      expect(config.contractAddresses).toEqual(['ADDR1', 'ADDR2', 'ADDR3'])
    })

    it('should provide default values for optional settings', () => {
      process.env.HORIZON_URL = 'https://horizon.stellar.org'
      process.env.CONTRACT_ADDRESS = 'CDISCIPLR'

      const config = loadHorizonListenerConfig()

      expect(config.startLedger).toBeUndefined()
      expect(config.retryMaxAttempts).toBe(3)
      expect(config.retryBackoffMs).toBe(100)
      expect(config.shutdownTimeoutMs).toBe(30000)
    })

    it('should handle missing environment variables gracefully', () => {
      const config = loadHorizonListenerConfig()

      expect(config.horizonUrl).toBe('')
      expect(config.contractAddresses).toEqual([])
      expect(config.startLedger).toBeUndefined()
      expect(config.retryMaxAttempts).toBe(3)
      expect(config.retryBackoffMs).toBe(100)
    })
  })

  describe('validateHorizonListenerConfig', () => {
    it('should pass validation with all required fields', () => {
      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractAddresses: ['CDISCIPLR'],
        retryMaxAttempts: 3,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      // Should not throw or exit
      expect(() => validateHorizonListenerConfig(config)).not.toThrow()
    })

    it('should fail validation when HORIZON_URL is missing', () => {
      const config = {
        horizonUrl: '',
        contractAddresses: ['CDISCIPLR'],
        retryMaxAttempts: 3,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('Configuration validation failed:')
      expect(mockConsoleError).toHaveBeenCalledWith('  - HORIZON_URL is required but not set')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should fail validation when CONTRACT_ADDRESS is empty', () => {
      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractAddresses: [],
        retryMaxAttempts: 3,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('  - CONTRACT_ADDRESS is required but not set or empty')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should fail validation with multiple missing fields', () => {
      const config = {
        horizonUrl: '',
        contractAddresses: [],
        retryMaxAttempts: 3,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('Configuration validation failed:')
      expect(mockConsoleError).toHaveBeenCalledWith('  - HORIZON_URL is required but not set')
      expect(mockConsoleError).toHaveBeenCalledWith('  - CONTRACT_ADDRESS is required but not set or empty')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should fail validation when START_LEDGER is negative', () => {
      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractAddresses: ['CDISCIPLR'],
        startLedger: -1,
        retryMaxAttempts: 3,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('  - START_LEDGER must be a non-negative number')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should fail validation when RETRY_MAX_ATTEMPTS is negative', () => {
      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractAddresses: ['CDISCIPLR'],
        retryMaxAttempts: -1,
        retryBackoffMs: 100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('  - RETRY_MAX_ATTEMPTS must be a non-negative number')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })

    it('should fail validation when RETRY_BACKOFF_MS is negative', () => {
      const config = {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        contractAddresses: ['CDISCIPLR'],
        retryMaxAttempts: 3,
        retryBackoffMs: -100,
        shutdownTimeoutMs: 30000,
      }

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => validateHorizonListenerConfig(config)).toThrow('process.exit: 1')
      expect(mockConsoleError).toHaveBeenCalledWith('  - RETRY_BACKOFF_MS must be a non-negative number')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })
  })

  describe('getValidatedConfig', () => {
    it('should load and validate configuration successfully', () => {
      process.env.HORIZON_URL = 'https://horizon-testnet.stellar.org'
      process.env.CONTRACT_ADDRESS = 'CDISCIPLR1,CDISCIPLR2'
      process.env.START_LEDGER = '12345'

      const config = getValidatedConfig()

      expect(config.horizonUrl).toBe('https://horizon-testnet.stellar.org')
      expect(config.contractAddresses).toEqual(['CDISCIPLR1', 'CDISCIPLR2'])
      expect(config.startLedger).toBe(12345)
    })

    it('should exit when validation fails', () => {
      process.env.HORIZON_URL = ''
      process.env.CONTRACT_ADDRESS = ''

      const mockExit = jest.spyOn(process, 'exit').mockImplementation((code?: string | number | null | undefined) => {
        throw new Error(`process.exit: ${code}`)
      })
      const mockConsoleError = jest.spyOn(console, 'error').mockImplementation(() => {})

      expect(() => getValidatedConfig()).toThrow('process.exit: 1')

      mockExit.mockRestore()
      mockConsoleError.mockRestore()
    })
  })
})
