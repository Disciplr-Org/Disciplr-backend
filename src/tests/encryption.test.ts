import { Buffer } from 'node:buffer'
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import {
  invalidateKeys,
  resolveKeys,
  encryptField,
  isEncrypted,
  decryptField,
  encryptNullable,
  decryptNullable,
  getKeyId,
  auditKeyUsage,
  DecryptionError,
  EncryptionKeyError,
} from '../lib/encryption.js'

describe('Field Encryption (src/lib/encryption.ts)', () => {
  // Deterministic 32-byte test keys (base64-encoded)
  const KEY_32_BYTES_1 = Buffer.alloc(32, 1).toString('base64')
  const KEY_32_BYTES_2 = Buffer.alloc(32, 2).toString('base64')

  const originalEnvKey = process.env.FIELD_ENCRYPTION_KEY
  const originalEnvKeys = process.env.FIELD_ENCRYPTION_KEYS

  beforeEach(() => {
    jest.useFakeTimers()
    delete process.env.FIELD_ENCRYPTION_KEYS
    process.env.FIELD_ENCRYPTION_KEY = KEY_32_BYTES_1
    invalidateKeys()
  })

  afterEach(() => {
    jest.useRealTimers()
    if (originalEnvKey !== undefined) {
      process.env.FIELD_ENCRYPTION_KEY = originalEnvKey
    } else {
      delete process.env.FIELD_ENCRYPTION_KEY
    }
    if (originalEnvKeys !== undefined) {
      process.env.FIELD_ENCRYPTION_KEYS = originalEnvKeys
    } else {
      delete process.env.FIELD_ENCRYPTION_KEYS
    }
    invalidateKeys()
  })

  // ── Error Classes ──────────────────────────────────────────────────────────

  describe('Error Classes', () => {
    it('DecryptionError should inherit from Error and have correct name', () => {
      const err = new DecryptionError('Decryption failed')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(DecryptionError)
      expect(err.name).toBe('DecryptionError')
      expect(err.message).toBe('Decryption failed')
    })

    it('EncryptionKeyError should inherit from Error and have correct name', () => {
      const err = new EncryptionKeyError('Key error')
      expect(err).toBeInstanceOf(Error)
      expect(err).toBeInstanceOf(EncryptionKeyError)
      expect(err.name).toBe('EncryptionKeyError')
      expect(err.message).toBe('Key error')
    })
  })

  // ── resolveKeys ────────────────────────────────────────────────────────────

  describe('resolveKeys', () => {
    it('happy path: resolves single key from FIELD_ENCRYPTION_KEY under default kid', () => {
      process.env.FIELD_ENCRYPTION_KEY = KEY_32_BYTES_1
      delete process.env.FIELD_ENCRYPTION_KEYS
      invalidateKeys()

      const keys = resolveKeys()
      expect(keys).toHaveLength(1)
      expect(keys[0].kid).toBe('default')
      expect(keys[0].key).toEqual(Buffer.alloc(32, 1))
    })

    it('happy path: resolves multiple keys from FIELD_ENCRYPTION_KEYS in priority order', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'active-key', key: KEY_32_BYTES_1 },
        { kid: 'retired-key', key: KEY_32_BYTES_2 },
      ])
      delete process.env.FIELD_ENCRYPTION_KEY
      invalidateKeys()

      const keys = resolveKeys()
      expect(keys).toHaveLength(2)
      expect(keys[0].kid).toBe('active-key')
      expect(keys[0].key).toEqual(Buffer.alloc(32, 1))
      expect(keys[1].kid).toBe('retired-key')
      expect(keys[1].key).toEqual(Buffer.alloc(32, 2))
    })

    it('happy path: FIELD_ENCRYPTION_KEYS takes precedence over FIELD_ENCRYPTION_KEY', () => {
      process.env.FIELD_ENCRYPTION_KEY = KEY_32_BYTES_1
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'json-key', key: KEY_32_BYTES_2 },
      ])
      invalidateKeys()

      const keys = resolveKeys()
      expect(keys).toHaveLength(1)
      expect(keys[0].kid).toBe('json-key')
      expect(keys[0].key).toEqual(Buffer.alloc(32, 2))
    })

    it('happy path: skips invalid or malformed retired keys with a warning and preserves valid keys', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'active-key', key: KEY_32_BYTES_1 },
        { kid: 'bad-shape-retired', key: 123 }, // invalid shape
        { kid: 'bad-length-retired', key: Buffer.alloc(16).toString('base64') }, // 16 bytes instead of 32
        null, // null entry
        { kid: 'valid-retired', key: KEY_32_BYTES_2 },
      ])
      invalidateKeys()

      const keys = resolveKeys()
      expect(keys).toHaveLength(2)
      expect(keys[0].kid).toBe('active-key')
      expect(keys[1].kid).toBe('valid-retired')
      expect(warnSpy).toHaveBeenCalled()
      warnSpy.mockRestore()
    })

    it('failure mode 1: throws EncryptionKeyError if neither key env variable is set or configured', () => {
      delete process.env.FIELD_ENCRYPTION_KEY
      delete process.env.FIELD_ENCRYPTION_KEYS
      invalidateKeys()

      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('No field encryption key configured')
    })

    it('failure mode 2: throws EncryptionKeyError if FIELD_ENCRYPTION_KEYS is not valid JSON', () => {
      process.env.FIELD_ENCRYPTION_KEYS = '{ invalid json'
      invalidateKeys()

      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('FIELD_ENCRYPTION_KEYS is not valid JSON')
    })

    it('failure mode 3: throws EncryptionKeyError if FIELD_ENCRYPTION_KEYS is an empty array or not an array', () => {
      process.env.FIELD_ENCRYPTION_KEYS = '[]'
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('must be a non-empty JSON array')

      process.env.FIELD_ENCRYPTION_KEYS = '{"kid": "default"}'
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('must be a non-empty JSON array')
    })

    it('failure mode 4: throws EncryptionKeyError if active key (index 0) has an invalid shape', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'active' }, // missing key
      ])
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('FIELD_ENCRYPTION_KEYS[0] must be an object with string "kid" and "key" fields')

      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([null])
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
    })

    it('failure mode 5: throws EncryptionKeyError if active key is not 32 bytes or invalid base64', () => {
      // 16 bytes instead of 32
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'short-key', key: Buffer.alloc(16).toString('base64') },
      ])
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('must decode to 32 bytes (got 16)')

      // Single key shorthand with wrong length
      delete process.env.FIELD_ENCRYPTION_KEYS
      process.env.FIELD_ENCRYPTION_KEY = Buffer.alloc(24).toString('base64')
      invalidateKeys()
      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('must decode to 32 bytes (got 24)')
    })

    it('failure mode 6: throws EncryptionKeyError if duplicate key IDs are configured', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'duplicate-kid', key: KEY_32_BYTES_1 },
        { kid: 'duplicate-kid', key: KEY_32_BYTES_2 },
      ])
      invalidateKeys()

      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => resolveKeys()).toThrow('Duplicate field encryption key id "duplicate-kid"')
    })
  })

  // ── invalidateKeys ─────────────────────────────────────────────────────────

  describe('invalidateKeys', () => {
    it('happy path: purges cached keys so updated environment variables take effect', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'key-v1', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      // Active key is cached as key-v1 on first encryption
      const ct1 = encryptField('test')
      expect(getKeyId(ct1)).toBe('key-v1')

      // Update env var to key-v2 without invalidating: encryptField still uses cached key-v1
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'key-v2', key: KEY_32_BYTES_2 },
      ])
      const ct2 = encryptField('test')
      expect(getKeyId(ct2)).toBe('key-v1')

      // After invalidateKeys: encryptField picks up the new key-v2
      invalidateKeys()
      const ct3 = encryptField('test')
      expect(getKeyId(ct3)).toBe('key-v2')
    })

    it('failure mode 1: purges cache so subsequent operations fail closed when env keys are deleted', () => {
      process.env.FIELD_ENCRYPTION_KEY = KEY_32_BYTES_1
      invalidateKeys()
      expect(resolveKeys()).toBeDefined()

      // Delete env vars; without invalidateKeys it would return old cached key
      delete process.env.FIELD_ENCRYPTION_KEY
      delete process.env.FIELD_ENCRYPTION_KEYS
      invalidateKeys()

      expect(() => resolveKeys()).toThrow(EncryptionKeyError)
      expect(() => encryptField('test')).toThrow(EncryptionKeyError)
    })

    it('failure mode 2: purges cache so subsequent operations fail closed when env keys become malformed', () => {
      process.env.FIELD_ENCRYPTION_KEY = KEY_32_BYTES_1
      invalidateKeys()
      expect(encryptField('hello')).toBeDefined()

      process.env.FIELD_ENCRYPTION_KEYS = 'malformed-json{'
      delete process.env.FIELD_ENCRYPTION_KEY
      invalidateKeys()

      expect(() => encryptField('hello')).toThrow(EncryptionKeyError)
    })
  })

  // ── encryptField ───────────────────────────────────────────────────────────

  describe('encryptField', () => {
    it('happy path: encrypts plaintext into v1:<kid>:<iv_b64>:<authTag_b64>:<ciphertext_b64>', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'active-key-v1', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const plaintext = 'super-secret-payload-12345'
      const ciphertext = encryptField(plaintext)

      expect(typeof ciphertext).toBe('string')
      const parts = ciphertext.split(':')
      expect(parts).toHaveLength(5)
      expect(parts[0]).toBe('v1')
      expect(parts[1]).toBe('active-key-v1')

      // IV must be 12 bytes base64 decoded
      const ivBuf = Buffer.from(parts[2], 'base64')
      expect(ivBuf.length).toBe(12)

      // Auth tag must be 16 bytes base64 decoded
      const tagBuf = Buffer.from(parts[3], 'base64')
      expect(tagBuf.length).toBe(16)

      // Ciphertext must be non-empty base64 decoded
      const cipherBuf = Buffer.from(parts[4], 'base64')
      expect(cipherBuf.length).toBeGreaterThan(0)
    })

    it('happy path: encrypts empty string cleanly', () => {
      const ciphertext = encryptField('')
      expect(isEncrypted(ciphertext)).toBe(true)
      expect(decryptField(ciphertext)).toBe('')
    })

    it('happy path: produces distinct IVs and ciphertexts for repeated encryptions of the same plaintext', () => {
      const secret = 'identical-secret'
      const ct1 = encryptField(secret)
      const ct2 = encryptField(secret)

      expect(ct1).not.toBe(ct2)
      const [, , iv1, tag1, body1] = ct1.split(':')
      const [, , iv2, tag2, body2] = ct2.split(':')
      expect(iv1).not.toBe(iv2)
      expect(tag1).not.toBe(tag2)
      expect(body1).not.toBe(body2)
    })

    it('failure mode 1: throws EncryptionKeyError if no keys are configured', () => {
      delete process.env.FIELD_ENCRYPTION_KEY
      delete process.env.FIELD_ENCRYPTION_KEYS
      invalidateKeys()

      expect(() => encryptField('secret')).toThrow(EncryptionKeyError)
    })

    it('failure mode 2: throws EncryptionKeyError if active key has invalid byte length', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'short', key: Buffer.alloc(10).toString('base64') },
      ])
      invalidateKeys()

      expect(() => encryptField('secret')).toThrow(EncryptionKeyError)
      expect(() => encryptField('secret')).toThrow('must decode to 32 bytes (got 10)')
    })
  })

  // ── isEncrypted ────────────────────────────────────────────────────────────

  describe('isEncrypted', () => {
    it('happy path: returns true for valid ciphertext produced by encryptField', () => {
      const ct = encryptField('plaintext')
      expect(isEncrypted(ct)).toBe(true)
    })

    it('happy path: returns true for properly structured 5-part v1 ciphertext string', () => {
      const fakeCiphertext = 'v1:kid:ivb64:tagb64:cipherb64'
      expect(isEncrypted(fakeCiphertext)).toBe(true)
    })

    it('failure mode 1: returns false for raw plaintext', () => {
      expect(isEncrypted('raw-plaintext-secret')).toBe(false)
      expect(isEncrypted('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).toBe(false)
    })

    it('failure mode 2: returns false for wrong scheme version', () => {
      expect(isEncrypted('v2:kid:iv:tag:ciphertext')).toBe(false)
      expect(isEncrypted('v0:kid:iv:tag:ciphertext')).toBe(false)
      expect(isEncrypted('v1')).toBe(false)
    })

    it('failure mode 3: returns false for invalid segment counts or empty string', () => {
      expect(isEncrypted('')).toBe(false)
      expect(isEncrypted('v1:kid:iv:tag')).toBe(false) // 4 segments
      expect(isEncrypted('v1:kid:iv:tag:cipher:extra')).toBe(false) // 6 segments
    })
  })

  // ── decryptField ───────────────────────────────────────────────────────────

  describe('decryptField', () => {
    it('happy path: round-trips ASCII and UTF-8 multi-byte strings', () => {
      const testCases = [
        'simple-secret',
        'Special chars: !@#$%^&*()_+~`|}{[]:;?><,./-=§±',
        'Unicode text: 🚀 ✨ 🔐 日本語 한국어 🌟',
        'Multi-line:\nLine 1\r\nLine 2\tTabbed',
      ]

      for (const text of testCases) {
        const encrypted = encryptField(text)
        expect(decryptField(encrypted)).toBe(text)
      }
    })

    it('happy path: round-trips empty string back to ""', () => {
      const encrypted = encryptField('')
      expect(decryptField(encrypted)).toBe('')
    })

    it('happy path: supports key rotation - decrypts ciphertext produced under a retired key', () => {
      // Step 1: Encrypt with initial key
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: '2026-01', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const originalSecret = 'secret-created-in-january'
      const ciphertext = encryptField(originalSecret)
      expect(ciphertext.startsWith('v1:2026-01:')).toBe(true)

      // Step 2: Rotate key: prepend new active key '2026-06', keep old key '2026-01'
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: '2026-06', key: KEY_32_BYTES_2 },
        { kid: '2026-01', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      // The old ciphertext must still decrypt under the retired key
      expect(decryptField(ciphertext)).toBe(originalSecret)

      // New writes use the new active key '2026-06'
      const newCiphertext = encryptField('secret-created-in-june')
      expect(newCiphertext.startsWith('v1:2026-06:')).toBe(true)
      expect(decryptField(newCiphertext)).toBe('secret-created-in-june')
    })

    it('failure mode 1: throws DecryptionError when ciphertext does not have 5 segments', () => {
      expect(() => decryptField('v1:single-part')).toThrow(DecryptionError)
      expect(() => decryptField('v1:single-part')).toThrow(
        'Malformed ciphertext: expected 5 colon-separated segments',
      )
      expect(() => decryptField('v1:1:2:3:4:5')).toThrow(DecryptionError)
    })

    it('failure mode 2: throws DecryptionError on unsupported scheme version', () => {
      const badVersion = 'v2:default:AAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:c3R1ZmY='
      expect(() => decryptField(badVersion)).toThrow(DecryptionError)
      expect(() => decryptField(badVersion)).toThrow(
        'Unsupported ciphertext scheme version "v2"',
      )
    })

    it('failure mode 3: throws DecryptionError when kid is unknown / not configured', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'current-key', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const ciphertext = 'v1:unknown-key-id:AAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:c3R1ZmY='
      expect(() => decryptField(ciphertext)).toThrow(DecryptionError)
      expect(() => decryptField(ciphertext)).toThrow(
        'No field encryption key configured for key id "unknown-key-id"',
      )
    })

    it('failure mode 4: throws DecryptionError when IV length is not 12 bytes', () => {
      const validCt = encryptField('secret')
      const [version, kid, , authTag, cipher] = validCt.split(':')
      const invalidIvB64 = Buffer.alloc(16).toString('base64') // 16 bytes instead of 12

      const tampered = [version, kid, invalidIvB64, authTag, cipher].join(':')
      expect(() => decryptField(tampered)).toThrow(DecryptionError)
      expect(() => decryptField(tampered)).toThrow('Malformed ciphertext: IV must be 12 bytes')
    })

    it('failure mode 5: throws DecryptionError when auth tag length is not 16 bytes', () => {
      const validCt = encryptField('secret')
      const [version, kid, iv, , cipher] = validCt.split(':')
      const invalidTagB64 = Buffer.alloc(12).toString('base64') // 12 bytes instead of 16

      const tampered = [version, kid, iv, invalidTagB64, cipher].join(':')
      expect(() => decryptField(tampered)).toThrow(DecryptionError)
      expect(() => decryptField(tampered)).toThrow('Malformed ciphertext: auth tag must be 16 bytes')
    })

    it('failure mode 6: throws DecryptionError when ciphertext byte is tampered (integrity verification)', () => {
      const validCt = encryptField('super-confidential')
      const [version, kid, iv, authTag, cipherB64] = validCt.split(':')

      const cipherBuf = Buffer.from(cipherB64, 'base64')
      // Flip the first bit
      cipherBuf[0] ^= 1
      const tamperedCipherB64 = cipherBuf.toString('base64')

      const tampered = [version, kid, iv, authTag, tamperedCipherB64].join(':')
      expect(() => decryptField(tampered)).toThrow(DecryptionError)
      expect(() => decryptField(tampered)).toThrow(
        'Failed to decrypt field under key id "default": authentication failed (wrong key or tampered ciphertext)',
      )
    })

    it('failure mode 7: throws DecryptionError when auth tag is tampered', () => {
      const validCt = encryptField('super-confidential')
      const [version, kid, iv, authTagB64, cipher] = validCt.split(':')

      const tagBuf = Buffer.from(authTagB64, 'base64')
      tagBuf[0] ^= 1
      const tamperedTagB64 = tagBuf.toString('base64')

      const tampered = [version, kid, iv, tamperedTagB64, cipher].join(':')
      expect(() => decryptField(tampered)).toThrow(DecryptionError)
      expect(() => decryptField(tampered)).toThrow('authentication failed')
    })

    it('failure mode 8: throws DecryptionError when IV is tampered', () => {
      const validCt = encryptField('super-confidential')
      const [version, kid, ivB64, authTag, cipher] = validCt.split(':')

      const ivBuf = Buffer.from(ivB64, 'base64')
      ivBuf[0] ^= 1
      const tamperedIvB64 = ivBuf.toString('base64')

      const tampered = [version, kid, tamperedIvB64, authTag, cipher].join(':')
      expect(() => decryptField(tampered)).toThrow(DecryptionError)
      expect(() => decryptField(tampered)).toThrow('authentication failed')
    })

    it('failure mode 9: throws DecryptionError when key material for the kid is wrong', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'shared-kid', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const validCt = encryptField('payload')

      // Now configure a different key under the same kid
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'shared-kid', key: KEY_32_BYTES_2 },
      ])
      invalidateKeys()

      expect(() => decryptField(validCt)).toThrow(DecryptionError)
      expect(() => decryptField(validCt)).toThrow('authentication failed (wrong key or tampered ciphertext)')
    })
  })

  // ── encryptNullable ────────────────────────────────────────────────────────

  describe('encryptNullable', () => {
    it('happy path: encrypts non-null strings into valid ciphertext', () => {
      const res = encryptNullable('valid-value')
      expect(res).not.toBeNull()
      expect(isEncrypted(res!)).toBe(true)
      expect(decryptField(res!)).toBe('valid-value')
    })

    it('happy path: returns null when input is null or undefined', () => {
      expect(encryptNullable(null)).toBeNull()
      expect(encryptNullable(undefined)).toBeNull()
    })

    it('failure mode 1: throws EncryptionKeyError when given a string but no keys are configured', () => {
      delete process.env.FIELD_ENCRYPTION_KEY
      delete process.env.FIELD_ENCRYPTION_KEYS
      invalidateKeys()

      expect(() => encryptNullable('some-text')).toThrow(EncryptionKeyError)
    })

    it('failure mode 2: throws EncryptionKeyError when given a string but active key is invalid', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'bad', key: Buffer.alloc(10).toString('base64') },
      ])
      invalidateKeys()

      expect(() => encryptNullable('some-text')).toThrow(EncryptionKeyError)
      expect(() => encryptNullable('some-text')).toThrow('must decode to 32 bytes (got 10)')
    })
  })

  // ── decryptNullable ────────────────────────────────────────────────────────

  describe('decryptNullable', () => {
    it('happy path: decrypts valid ciphertext string', () => {
      const ct = encryptField('nullable-secret')
      expect(decryptNullable(ct)).toBe('nullable-secret')
    })

    it('happy path: returns null when input is null or undefined', () => {
      expect(decryptNullable(null)).toBeNull()
      expect(decryptNullable(undefined)).toBeNull()
    })

    it('failure mode 1: throws DecryptionError when input is a tampered ciphertext string', () => {
      const validCt = encryptField('secret')
      const [version, kid, iv, authTag] = validCt.split(':')
      const tampered = [version, kid, iv, authTag, Buffer.from('corrupt').toString('base64')].join(':')

      expect(() => decryptNullable(tampered)).toThrow(DecryptionError)
    })

    it('failure mode 2: throws DecryptionError when input is raw plaintext string', () => {
      expect(() => decryptNullable('not-encrypted-plaintext')).toThrow(DecryptionError)
      expect(() => decryptNullable('not-encrypted-plaintext')).toThrow('Malformed ciphertext: expected 5 colon-separated segments')
    })

    it('failure mode 3: throws DecryptionError when ciphertext has an unknown kid', () => {
      const unknownKidCt = 'v1:unknown:AAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:c3R1ZmY='
      expect(() => decryptNullable(unknownKidCt)).toThrow(DecryptionError)
      expect(() => decryptNullable(unknownKidCt)).toThrow('No field encryption key configured for key id "unknown"')
    })
  })

  // ── getKeyId ───────────────────────────────────────────────────────────────

  describe('getKeyId', () => {
    it('happy path: returns the kid from a valid ciphertext string', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'custom-kid-2026', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const ct = encryptField('test')
      expect(getKeyId(ct)).toBe('custom-kid-2026')
    })

    it('happy path: returns "default" when encrypted under single-key default configuration', () => {
      const ct = encryptField('test')
      expect(getKeyId(ct)).toBe('default')
    })

    it('failure mode 1: returns null for raw unencrypted plaintext', () => {
      expect(getKeyId('raw-text-value')).toBeNull()
      expect(getKeyId('just a regular string with no colons')).toBeNull()
    })

    it('failure mode 2: returns null for malformed or wrong-version strings', () => {
      expect(getKeyId('v2:my-kid:iv:tag:cipher')).toBeNull()
      expect(getKeyId('v1:kid:only-three-segments')).toBeNull()
      expect(getKeyId('')).toBeNull()
    })
  })

  // ── auditKeyUsage ──────────────────────────────────────────────────────────

  describe('auditKeyUsage', () => {
    it('happy path: tallies countsByKid, unencryptedCount, and totalCount across mixed records', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'key-a', key: KEY_32_BYTES_1 },
        { kid: 'key-b', key: KEY_32_BYTES_2 },
      ])
      invalidateKeys()

      const ctA1 = encryptField('a1')
      const ctA2 = encryptField('a2')

      // Switch active to key-b to generate ciphertext with key-b
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'key-b', key: KEY_32_BYTES_2 },
        { kid: 'key-a', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const ctB1 = encryptField('b1')

      const records = [
        ctA1,
        null, // should be ignored in totalCount
        ctA2,
        undefined, // should be ignored in totalCount
        ctB1,
        'unencrypted-plaintext-value',
      ]

      const report = auditKeyUsage(records)
      expect(report.totalCount).toBe(4) // 3 encrypted + 1 plaintext
      expect(report.countsByKid).toEqual({
        'key-a': 2,
        'key-b': 1,
      })
      expect(report.unencryptedCount).toBe(1)
      expect(report.unknownKidCount).toBe(0)
    })

    it('happy path: returns zero counts for an empty array or array containing only null/undefined', () => {
      const emptyReport = auditKeyUsage([])
      expect(emptyReport).toEqual({
        countsByKid: {},
        unencryptedCount: 0,
        unknownKidCount: 0,
        totalCount: 0,
      })

      const nullsReport = auditKeyUsage([null, undefined, null])
      expect(nullsReport).toEqual({
        countsByKid: {},
        unencryptedCount: 0,
        unknownKidCount: 0,
        totalCount: 0,
      })
    })

    it('failure mode 1: counts unknown kid when ciphertext has a kid not currently configured', () => {
      process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
        { kid: 'configured-key', key: KEY_32_BYTES_1 },
      ])
      invalidateKeys()

      const unknownKidCt = 'v1:retired-and-removed-kid:AAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:c3R1ZmY='
      const report = auditKeyUsage([unknownKidCt])

      expect(report.totalCount).toBe(1)
      expect(report.countsByKid).toEqual({
        'retired-and-removed-kid': 1,
      })
      expect(report.unknownKidCount).toBe(1)
      expect(report.unencryptedCount).toBe(0)
    })

    it('failure mode 2: counts malformed encrypted strings as unencryptedCount', () => {
      const malformedRecords = [
        'v2:future-scheme:iv:tag:cipher', // wrong version
        'v1:not:enough:parts', // 4 parts instead of 5
        'completely-unencrypted',
      ]

      const report = auditKeyUsage(malformedRecords)
      expect(report.totalCount).toBe(3)
      expect(report.unencryptedCount).toBe(3)
      expect(report.unknownKidCount).toBe(0)
      expect(report.countsByKid).toEqual({})
    })
  })
})
