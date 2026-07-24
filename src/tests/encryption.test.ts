/**
 * Tests for field-level envelope encryption (src/lib/encryption.ts).
 *
 * Covers the security-critical behaviours called out in the design:
 *   - round-trip of arbitrary plaintext (including empty / unicode);
 *   - tamper detection via the GCM auth tag;
 *   - wrong-key rejection;
 *   - key-id tagged rotation: data written under a retired key still decrypts;
 *   - fail-closed when no key is configured (startup misconfiguration);
 *   - never silently returning ciphertext on a decryption failure.
 *
 * Keys are configured purely through process.env, which resolveKeys() reads
 * fresh on every call, so each test sets the exact key set it needs.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { randomBytes } from 'node:crypto'
import {
  encryptField,
  decryptField,
  encryptNullable,
  decryptNullable,
  isEncrypted,
  resolveKeys,
  DecryptionError,
  EncryptionKeyError,
} from '../lib/encryption.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const genKey = (): string => randomBytes(32).toString('base64')

/** Snapshot and restore the encryption env vars around each test. */
let savedKey: string | undefined
let savedKeys: string | undefined

beforeEach(() => {
  savedKey = process.env.FIELD_ENCRYPTION_KEY
  savedKeys = process.env.FIELD_ENCRYPTION_KEYS
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY
  else process.env.FIELD_ENCRYPTION_KEY = savedKey
  if (savedKeys === undefined) delete process.env.FIELD_ENCRYPTION_KEYS
  else process.env.FIELD_ENCRYPTION_KEYS = savedKeys
})

const useSingleKey = (key = genKey()): string => {
  delete process.env.FIELD_ENCRYPTION_KEYS
  process.env.FIELD_ENCRYPTION_KEY = key
  return key
}

// ─── Round-trip ────────────────────────────────────────────────────────────────

describe('encryptField / decryptField round-trip', () => {
  beforeEach(() => useSingleKey())

  it('round-trips a typical secret', () => {
    const plaintext = 'whsec_' + randomBytes(24).toString('hex')
    const encrypted = encryptField(plaintext)
    expect(encrypted).not.toContain(plaintext)
    expect(decryptField(encrypted)).toBe(plaintext)
  })

  it('round-trips an empty string', () => {
    const encrypted = encryptField('')
    expect(isEncrypted(encrypted)).toBe(true)
    expect(decryptField(encrypted)).toBe('')
  })

  it('round-trips unicode and long plaintext', () => {
    const plaintext = '🔐 secret — ' + 'x'.repeat(10_000) + ' Ω'
    expect(decryptField(encryptField(plaintext))).toBe(plaintext)
  })

  it('produces a different ciphertext each time (random IV)', () => {
    const a = encryptField('same')
    const b = encryptField('same')
    expect(a).not.toBe(b)
    expect(decryptField(a)).toBe('same')
    expect(decryptField(b)).toBe('same')
  })

  it('tags ciphertext with the v1 scheme and the active key id', () => {
    const encrypted = encryptField('hello')
    const [version, kid] = encrypted.split(':')
    expect(version).toBe('v1')
    expect(kid).toBe('default') // single-key shorthand uses the "default" id
  })
})

// ─── isEncrypted ────────────────────────────────────────────────────────────────

describe('isEncrypted', () => {
  beforeEach(() => useSingleKey())

  it('recognises encryptField output', () => {
    expect(isEncrypted(encryptField('x'))).toBe(true)
  })

  it('rejects plaintext and other shapes', () => {
    expect(isEncrypted('plain text secret')).toBe(false)
    expect(isEncrypted('v1:only:three')).toBe(false)
    expect(isEncrypted('v2:a:b:c:d')).toBe(false)
  })
})

// ─── Tamper detection ───────────────────────────────────────────────────────────

describe('tamper detection (GCM auth failure)', () => {
  beforeEach(() => useSingleKey())

  it('rejects a flipped byte in the ciphertext segment', () => {
    const encrypted = encryptField('tamper-me')
    const parts = encrypted.split(':')
    const cipherBuf = Buffer.from(parts[4], 'base64')
    cipherBuf[0] ^= 0x01 // flip one bit
    parts[4] = cipherBuf.toString('base64')
    const tampered = parts.join(':')

    expect(() => decryptField(tampered)).toThrow(DecryptionError)
  })

  it('rejects a tampered auth tag', () => {
    const encrypted = encryptField('tamper-me')
    const parts = encrypted.split(':')
    const tagBuf = Buffer.from(parts[3], 'base64')
    tagBuf[0] ^= 0xff
    parts[3] = tagBuf.toString('base64')

    expect(() => decryptField(parts.join(':'))).toThrow(DecryptionError)
  })

  it('rejects a tampered IV', () => {
    const encrypted = encryptField('tamper-me')
    const parts = encrypted.split(':')
    const ivBuf = Buffer.from(parts[2], 'base64')
    ivBuf[0] ^= 0xff
    parts[2] = ivBuf.toString('base64')

    expect(() => decryptField(parts.join(':'))).toThrow(DecryptionError)
  })

  it('never returns the ciphertext on failure (no silent passthrough)', () => {
    const encrypted = encryptField('secret')
    const parts = encrypted.split(':')
    parts[4] = Buffer.from('garbage').toString('base64')
    const tampered = parts.join(':')

    let returned: string | undefined
    try {
      returned = decryptField(tampered)
    } catch {
      returned = undefined
    }
    expect(returned).toBeUndefined()
  })
})

// ─── Malformed input ─────────────────────────────────────────────────────────────

describe('malformed ciphertext', () => {
  beforeEach(() => useSingleKey())

  it('rejects a value with the wrong number of segments', () => {
    expect(() => decryptField('not-encrypted')).toThrow(DecryptionError)
    expect(() => decryptField('v1:default:iv:tag')).toThrow(/5 colon-separated/)
  })

  it('rejects an unsupported scheme version', () => {
    const e = encryptField('x').split(':')
    e[0] = 'v9'
    expect(() => decryptField(e.join(':'))).toThrow(/scheme version/)
  })

  it('rejects an IV of the wrong length', () => {
    const e = encryptField('x').split(':')
    e[2] = Buffer.alloc(8, 1).toString('base64') // 8 bytes, expected 12
    expect(() => decryptField(e.join(':'))).toThrow(/IV must be/)
  })
})

// ─── Wrong key ───────────────────────────────────────────────────────────────────

describe('wrong key rejection', () => {
  it('cannot decrypt with a different key under the same key id', () => {
    useSingleKey(genKey())
    const encrypted = encryptField('secret')

    // Swap in a different key but keep the id ("default") so lookup succeeds
    // and only the GCM auth check fails.
    useSingleKey(genKey())
    expect(() => decryptField(encrypted)).toThrow(DecryptionError)
    expect(() => decryptField(encrypted)).toThrow(/authentication failed/)
  })
})

// ─── Key rotation (key-id tagging) ──────────────────────────────────────────────

describe('key rotation via FIELD_ENCRYPTION_KEYS', () => {
  it('decrypts data written under a now-retired key', () => {
    const oldKey = genKey()
    const newKey = genKey()

    // 1. Write under the original key (id "k1").
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([{ kid: 'k1', key: oldKey }])
    const ciphertext = encryptField('rotate-me')
    expect(ciphertext.split(':')[1]).toBe('k1')

    // 2. Rotate: k2 becomes active, k1 retained for decryption only.
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
      { kid: 'k2', key: newKey },
      { kid: 'k1', key: oldKey },
    ])

    // Old data still decrypts (tagged k1)…
    expect(decryptField(ciphertext)).toBe('rotate-me')
    // …and new data is written under the active key k2.
    const fresh = encryptField('new-data')
    expect(fresh.split(':')[1]).toBe('k2')
    expect(decryptField(fresh)).toBe('new-data')
  })

  it('the first key in the list is the active encryption key', () => {
    const k1 = genKey()
    const k2 = genKey()
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
      { kid: 'primary', key: k1 },
      { kid: 'secondary', key: k2 },
    ])
    expect(resolveKeys()[0].kid).toBe('primary')
    expect(encryptField('x').split(':')[1]).toBe('primary')
  })

  it('fails decryption when the tagged key id was rotated out entirely', () => {
    const oldKey = genKey()
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([{ kid: 'k1', key: oldKey }])
    const ciphertext = encryptField('orphan')

    // Replace k1 with an unrelated key id — k1 is no longer resolvable.
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([{ kid: 'k2', key: genKey() }])
    expect(() => decryptField(ciphertext)).toThrow(/No field encryption key configured for key id "k1"/)
  })
})

// ─── Key configuration / startup failures ───────────────────────────────────────

describe('key configuration validation', () => {
  it('throws when no key is configured (fail closed)', () => {
    delete process.env.FIELD_ENCRYPTION_KEY
    delete process.env.FIELD_ENCRYPTION_KEYS
    expect(() => resolveKeys()).toThrow(EncryptionKeyError)
    expect(() => encryptField('x')).toThrow(/No field encryption key configured/)
  })

  it('rejects a key that is not 32 bytes', () => {
    useSingleKey(randomBytes(16).toString('base64')) // 16 bytes, too short
    expect(() => resolveKeys()).toThrow(/must decode to 32 bytes/)
  })

  it('rejects malformed FIELD_ENCRYPTION_KEYS JSON', () => {
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = '{ not json'
    expect(() => resolveKeys()).toThrow(/not valid JSON/)
  })

  it('rejects an empty FIELD_ENCRYPTION_KEYS array', () => {
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = '[]'
    expect(() => resolveKeys()).toThrow(/non-empty JSON array/)
  })

  it('rejects entries missing kid or key', () => {
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([{ kid: 'k1' }])
    expect(() => resolveKeys()).toThrow(/string "kid" and "key"/)
  })

  it('rejects duplicate key ids', () => {
    const key = genKey()
    delete process.env.FIELD_ENCRYPTION_KEY
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([
      { kid: 'dup', key },
      { kid: 'dup', key },
    ])
    expect(() => resolveKeys()).toThrow(/Duplicate field encryption key id "dup"/)
  })

  it('prefers FIELD_ENCRYPTION_KEYS over FIELD_ENCRYPTION_KEY when both are set', () => {
    process.env.FIELD_ENCRYPTION_KEY = genKey()
    process.env.FIELD_ENCRYPTION_KEYS = JSON.stringify([{ kid: 'json-key', key: genKey() }])
    expect(resolveKeys()).toHaveLength(1)
    expect(resolveKeys()[0].kid).toBe('json-key')
  })
})

// ─── Nullable helpers ────────────────────────────────────────────────────────────

describe('encryptNullable / decryptNullable', () => {
  beforeEach(() => useSingleKey())

  it('passes null and undefined through unchanged', () => {
    expect(encryptNullable(null)).toBeNull()
    expect(encryptNullable(undefined)).toBeNull()
    expect(decryptNullable(null)).toBeNull()
    expect(decryptNullable(undefined)).toBeNull()
  })

  it('encrypts and decrypts a present value', () => {
    const encrypted = encryptNullable('present')
    expect(encrypted).not.toBeNull()
    expect(isEncrypted(encrypted!)).toBe(true)
    expect(decryptNullable(encrypted)).toBe('present')
  })
})
