import { jest } from '@jest/globals'
import {
  HorizonListenerConfig,
  HorizonListenerConfigError,
  validateHorizonListenerConfig,
  isValidContractAddressString,
  sanitizeContractAddresses,
  loadHorizonListenerConfig,
} from '../config/horizonListener.js'

describe('HorizonListener Configuration & Hostile-Input Boundary', () => {
  const baseValidConfig: HorizonListenerConfig = {
    horizonUrl: 'https://horizon-testnet.stellar.org',
    contractAddresses: ['CA3D5KRYM6CB7OWQ6TWYRR3Z4T7ZQVNCUS245PQ5GDAJZ4VMTOD5EGGG'],
    startLedger: 1000,
    retryMaxAttempts: 3,
    retryBackoffMs: 250,
    shutdownTimeoutMs: 10000,
    lagThreshold: 30,
  }

  describe('URL validation', () => {
    it('accepts valid https and http URLs', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'https://horizon.stellar.org',
        }),
      ).not.toThrow()

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'http://localhost:8000',
        }),
      ).not.toThrow()
    })

    it('rejects missing, empty, or whitespace-only URLs', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: '',
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: '   ',
        }),
      ).toThrow(HorizonListenerConfigError)
    })

    it('rejects non-HTTP schemes (e.g. ftp, file, javascript)', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'ftp://horizon.stellar.org',
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'javascript:alert(1)',
        }),
      ).toThrow(HorizonListenerConfigError)
    })

    it('rejects URLs with embedded user credentials', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'https://admin:secret@horizon-testnet.stellar.org',
        }),
      ).toThrow(HorizonListenerConfigError)
    })

    it('rejects malformed URLs without valid hostnames', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          horizonUrl: 'https://',
        }),
      ).toThrow(HorizonListenerConfigError)
    })
  })

  describe('Contract address validation & sanitization', () => {
    it('accepts valid Soroban contract IDs and alphanumeric identifiers', () => {
      expect(isValidContractAddressString('CA3D5KRYM6CB7OWQ6TWYRR3Z4T7ZQVNCUS245PQ5GDAJZ4VMTOD5EGGG')).toBe(true)
      expect(isValidContractAddressString('CTEST123')).toBe(true)
      expect(isValidContractAddressString('contract_vault_01')).toBe(true)
    })

    it('rejects empty, whitespace, or invalid characters', () => {
      expect(isValidContractAddressString('')).toBe(false)
      expect(isValidContractAddressString('   ')).toBe(false)
      expect(isValidContractAddressString('contract with spaces')).toBe(false)
      expect(isValidContractAddressString('contract;drop table')).toBe(false)
      expect(isValidContractAddressString(null)).toBe(false)
      expect(isValidContractAddressString(undefined)).toBe(false)
    })

    it('sanitizes and deduplicates contract addresses', () => {
      const input = [
        ' CTEST1 ',
        'CTEST2',
        'CTEST1',
        '',
        '   ',
        'CTEST3',
      ]
      const sanitized = sanitizeContractAddresses(input)
      expect(sanitized).toEqual(['CTEST1', 'CTEST2', 'CTEST3'])
    })

    it('rejects config with empty contractAddresses array', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          contractAddresses: [],
        }),
      ).toThrow(HorizonListenerConfigError)
    })

    it('rejects config with invalid contract address format entries', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          contractAddresses: ['CTEST1', 'invalid address with spaces!'],
        }),
      ).toThrow(HorizonListenerConfigError)
    })
  })

  describe('Numeric boundary validation', () => {
    it('validates startLedger bounds', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          startLedger: 0,
        }),
      ).not.toThrow()

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          startLedger: -1,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          startLedger: NaN,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          startLedger: 1.5,
        }),
      ).toThrow(HorizonListenerConfigError)
    })

    it('validates retryMaxAttempts bounds (1 to 100)', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryMaxAttempts: 0,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryMaxAttempts: 101,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryMaxAttempts: 5,
        }),
      ).not.toThrow()
    })

    it('validates retryBackoffMs bounds (0 to 300,000)', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryBackoffMs: -1,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryBackoffMs: 300_001,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          retryBackoffMs: 1000,
        }),
      ).not.toThrow()
    })

    it('validates shutdownTimeoutMs bounds (1,000 to 300,000)', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          shutdownTimeoutMs: 500,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          shutdownTimeoutMs: 300_001,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          shutdownTimeoutMs: 30_000,
        }),
      ).not.toThrow()
    })

    it('validates lagThreshold bounds (0 to 100,000)', () => {
      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          lagThreshold: -1,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          lagThreshold: 100_001,
        }),
      ).toThrow(HorizonListenerConfigError)

      expect(() =>
        validateHorizonListenerConfig({
          ...baseValidConfig,
          lagThreshold: 50,
        }),
      ).not.toThrow()
    })
  })
})
