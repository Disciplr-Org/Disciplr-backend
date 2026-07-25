/**
 * Field-level envelope encryption for reversible secrets at rest.
 *
 * Some secrets cannot be hashed because they must be recovered in plaintext at
 * use time — most notably webhook HMAC signing secrets, which have to be
 * re-presented to re-sign outbound payloads. For those columns we encrypt with
 * authenticated encryption (AES-256-GCM) so that:
 *
 *   - a database dump alone never exposes the plaintext secret;
 *   - any tampering with the stored ciphertext is detected (GCM auth tag);
 *   - keys can be rotated without a bulk re-encryption: every ciphertext is
 *     tagged with the id of the key that produced it, so old rows keep
 *     decrypting under the retired key while new writes use the active key.
 *
 * ── Stored format ──────────────────────────────────────────────────────────
 * encryptField() returns a single self-describing string:
 *
 *     v1:<kid>:<iv_b64>:<authTag_b64>:<ciphertext_b64>
 *
 *   - `v1`         scheme version, so the format can evolve.
 *   - `<kid>`      id of the key used; resolved back to key material on decrypt.
 *   - `<iv_b64>`   12-byte random nonce, base64.
 *   - `<authTag>`  16-byte GCM authentication tag, base64.
 *   - `<cipher>`   the ciphertext, base64.
 *
 * Decryption never silently returns the input on failure — a bad key, an
 * unknown key id, a malformed value, or a failed auth-tag check all throw a
 * DecryptionError so corrupt/forged data can never be mistaken for plaintext.
 *
 * ── Key configuration ──────────────────────────────────────────────────────
 * See src/config/env.ts for FIELD_ENCRYPTION_KEY / FIELD_ENCRYPTION_KEYS and
 * docs/field-encryption.md for the key-rotation runbook.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { getFieldEncryptionConfig } from '../config/env.js'

/** Current stored-format scheme version. */
const SCHEME_VERSION = 'v1'

/** AES-256-GCM constants. */
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32 // AES-256
const IV_BYTES = 12 // 96-bit nonce recommended for GCM
const AUTH_TAG_BYTES = 16

/** Key id reserved for the single-key FIELD_ENCRYPTION_KEY shorthand. */
const DEFAULT_KEY_ID = 'default'

/** A resolved encryption key: an id and its 32-byte secret material. */
export interface FieldEncryptionKey {
  kid: string
  key: Buffer
}

/** Raised on any condition that prevents recovering the original plaintext. */
export class DecryptionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecryptionError'
  }
}

/** Raised when encryption keys are missing or malformed (a startup/config bug). */
export class EncryptionKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionKeyError'
  }
}

/**
 * Decodes and validates a single base64 AES-256 key.
 * Throws EncryptionKeyError if it is not exactly 32 decoded bytes.
 */
const decodeKey = (kid: string, raw: string): Buffer => {
  let buf: Buffer
  try {
    buf = Buffer.from(raw, 'base64')
  } catch {
    throw new EncryptionKeyError(`Field encryption key "${kid}" is not valid base64`)
  }
  if (buf.length !== KEY_BYTES) {
    throw new EncryptionKeyError(
      `Field encryption key "${kid}" must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
        `generate one with: openssl rand -base64 32`,
    )
  }
  return buf
}

/**
 * Resolves the configured field-encryption keys, in priority order.
 *
 * The FIRST key in the returned list is the active key used to encrypt new
 * data. Subsequent keys are retained only so older ciphertext keeps decrypting.
 *
 * Resolution rules:
 *   - FIELD_ENCRYPTION_KEYS (JSON array of {kid, key}) takes precedence.
 *   - Otherwise FIELD_ENCRYPTION_KEY is used as the single active "default" key.
 *   - If neither is set, EncryptionKeyError is thrown (fail closed): an
 *     encryption helper with no keys is a misconfiguration, never a no-op.
 *
 * Duplicate key ids are rejected so a typo cannot make a retired key
 * unexpectedly shadow the active one.
 */
export const resolveKeys = (): FieldEncryptionKey[] => {
  const { key: singleKey, keys: keysJson } = getFieldEncryptionConfig()

  let keys: FieldEncryptionKey[] = []

  if (keysJson && keysJson.trim() !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(keysJson)
    } catch (e) {
      throw new EncryptionKeyError(
        `FIELD_ENCRYPTION_KEYS is not valid JSON: ${(e as Error).message}`,
      )
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new EncryptionKeyError(
        'FIELD_ENCRYPTION_KEYS must be a non-empty JSON array of { kid, key } objects',
      )
    }
    keys = parsed.map((entry, i) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        typeof (entry as any).kid !== 'string' ||
        typeof (entry as any).key !== 'string'
      ) {
        throw new EncryptionKeyError(
          `FIELD_ENCRYPTION_KEYS[${i}] must be an object with string "kid" and "key" fields`,
        )
      }
      const kid = (entry as any).kid as string
      return { kid, key: decodeKey(kid, (entry as any).key as string) }
    })
  } else if (singleKey && singleKey.trim() !== '') {
    keys = [{ kid: DEFAULT_KEY_ID, key: decodeKey(DEFAULT_KEY_ID, singleKey) }]
  }

  if (keys.length === 0) {
    throw new EncryptionKeyError(
      'No field encryption key configured: set FIELD_ENCRYPTION_KEY or FIELD_ENCRYPTION_KEYS',
    )
  }

  const seen = new Set<string>()
  for (const { kid } of keys) {
    if (seen.has(kid)) {
      throw new EncryptionKeyError(`Duplicate field encryption key id "${kid}"`)
    }
    seen.add(kid)
  }

  return keys
}

/** Returns the active key (first configured) used to encrypt new data. */
const activeKey = (): FieldEncryptionKey => resolveKeys()[0]

/** Looks up a key by id, returning undefined if no such key is configured. */
const keyById = (kid: string): FieldEncryptionKey | undefined =>
  resolveKeys().find((k) => k.kid === kid)

/**
 * Encrypts a plaintext field value under the active key.
 *
 * Empty strings are encrypted like any other value (round-trips back to "")
 * so callers don't need a special case; null/undefined handling is left to the
 * caller since columns differ in nullability.
 *
 * @returns the self-describing ciphertext string (see module docs for format).
 */
export const encryptField = (plaintext: string): string => {
  const { kid, key } = activeKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()

  return [
    SCHEME_VERSION,
    kid,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Returns true if `value` looks like output of encryptField().
 *
 * Useful for read paths that may encounter a mix of already-encrypted rows and
 * legacy plaintext rows during a migration window.
 */
export const isEncrypted = (value: string): boolean =>
  value.startsWith(`${SCHEME_VERSION}:`) && value.split(':').length === 5

/**
 * Decrypts a value produced by encryptField().
 *
 * Throws DecryptionError on any failure — malformed input, unknown key id, or a
 * failed GCM authentication check (tampered ciphertext / wrong key). It never
 * returns the ciphertext or a partial result, so corrupt or forged data can
 * never be silently treated as plaintext.
 */
export const decryptField = (stored: string): string => {
  const parts = stored.split(':')
  if (parts.length !== 5) {
    throw new DecryptionError('Malformed ciphertext: expected 5 colon-separated segments')
  }

  const [version, kid, ivB64, authTagB64, ciphertextB64] = parts
  if (version !== SCHEME_VERSION) {
    throw new DecryptionError(`Unsupported ciphertext scheme version "${version}"`)
  }

  const resolved = keyById(kid)
  if (!resolved) {
    throw new DecryptionError(
      `No field encryption key configured for key id "${kid}"; ` +
        'the key may have been rotated out before all data was re-encrypted',
    )
  }

  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')

  if (iv.length !== IV_BYTES) {
    throw new DecryptionError(`Malformed ciphertext: IV must be ${IV_BYTES} bytes`)
  }
  if (authTag.length !== AUTH_TAG_BYTES) {
    throw new DecryptionError(
      `Malformed ciphertext: auth tag must be ${AUTH_TAG_BYTES} bytes`,
    )
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, resolved.key, iv)
    decipher.setAuthTag(authTag)
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return plaintext.toString('utf8')
  } catch {
    // GCM final() throws when the auth tag does not verify: wrong key or the
    // ciphertext/iv/tag was tampered with. Surface a clear, non-leaky error.
    throw new DecryptionError(
      `Failed to decrypt field under key id "${kid}": authentication failed ` +
        '(wrong key or tampered ciphertext)',
    )
  }
}

/**
 * Encrypts a nullable field value: passes null/undefined through unchanged so
 * nullable columns (e.g. previous_secret) keep their NULL semantics.
 */
export const encryptNullable = (plaintext: string | null | undefined): string | null =>
  plaintext === null || plaintext === undefined ? null : encryptField(plaintext)

/**
 * Decrypts a nullable stored value: passes null/undefined through unchanged.
 */
export const decryptNullable = (stored: string | null | undefined): string | null =>
  stored === null || stored === undefined ? null : decryptField(stored)
