import { checkListenerLag } from '../services/monitor.js'
import { Server } from '@stellar/stellar-sdk'
import { db } from '../db/knex.js'
import { getValidatedConfig } from '../config/horizonListener.js'
import { jest } from '@jest/globals'

// Mock dependencies
jest.mock('@stellar/stellar-sdk')
jest.mock('../db/knex.js')
jest.mock('../config/horizonListener.js')

describe('checkListenerLag', () => {
  let consoleWarnSpy: any
  let consoleErrorSpy: any

  beforeEach(() => {
    jest.clearAllMocks()
    
    // Spy on console methods
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {})
    
    // Default mock config
    ;(getValidatedConfig as any).mockReturnValue({
      horizonUrl: 'https://horizon-testnet.stellar.org',
      lagThreshold: 10,
      startLedger: 100,
      contractAddresses: ['CTEST123']
    })
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('should log a warning when lag exceeds threshold', async () => {
    // Mock Horizon Server response
    const mockServer = {
      ledgers: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({
        records: [{ sequence: 150 }]
      })
    }
    ;(Server as any).mockImplementation(() => mockServer)

    // Mock DB response for listener_state
    const mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ last_processed_ledger: 100 })
    }
    ;(db as any).mockReturnValue(mockQueryBuilder)

    await checkListenerLag()

    // Verify warning was logged
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Horizon listener lag detected: 50 ledgers'))
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Latest ledger: 150, Last processed: 100'))
  })

  it('should not log a warning when lag is within threshold', async () => {
    // Mock Horizon Server response
    const mockServer = {
      ledgers: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({
        records: [{ sequence: 105 }]
      })
    }
    ;(Server as any).mockImplementation(() => mockServer)

    // Mock DB response for listener_state
    const mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ last_processed_ledger: 100 })
    }
    ;(db as any).mockReturnValue(mockQueryBuilder)

    await checkListenerLag()

    // Verify no warning was logged
    expect(consoleWarnSpy).not.toHaveBeenCalled()
  })

  it('should use startLedger from config if no state exists in DB', async () => {
    // Mock Horizon Server response
    const mockServer = {
      ledgers: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      call: jest.fn().mockResolvedValue({
        records: [{ sequence: 150 }]
      })
    }
    ;(Server as any).mockImplementation(() => mockServer)

    // Mock DB response as null (no state yet)
    const mockQueryBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null)
    }
    ;(db as any).mockReturnValue(mockQueryBuilder)

    await checkListenerLag()

    // Verify lag check used startLedger (100)
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Horizon listener lag detected: 50 ledgers'))
  })

  it('should handle errors gracefully without crashing', async () => {
    // Mock Horizon Server to throw error
    const mockServer = {
      ledgers: jest.fn().mockImplementation(() => {
        throw new Error('Connection failed')
      })
    }
    ;(Server as any).mockImplementation(() => mockServer)

    await expect(checkListenerLag()).resolves.not.toThrow()
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Error checking listener lag:'), expect.any(Error))
  })
})
