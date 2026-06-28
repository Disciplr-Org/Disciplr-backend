import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import argon2 from 'argon2'
import type { Pool } from 'pg'
import type { ApiKeyAuthContext, ApiKeyRecord, ApiScope } from '../types/auth.js'
import { utcNow } from '../utils/timestamps.js'
import { getPgPool } from '../db/pool.js'
import * as argon2 from 'argon2'

interface CreateApiKeyInput {
  userId?: string
  orgId?: string
  label: string
  scopes: ApiScope[]
}

interface RotateApiKeyInput {
  apiKeyId: string
  userId: string
}

type ApiKeyValidationResult =
  | { valid: true; context: ApiKeyAuthContext }
  | { valid: false; reason: 'malformed' | 'invalid' | 'revoked' | 'forbidden' }

interface ApiKeyRow {
  id: string
  user_id: string | null
  org_id: string | null
  key_hash: string
  label: string
  scopes: string[] | string | null
  created_at: string | Date
  revoked_at: string | Date | null
}

interface ApiKeyRepository {
  create(record: ApiKeyRecord): Promise<void>
  listForUser(userId: string): Promise<ApiKeyRecord[]>
  getById(id: string): Promise<ApiKeyRecord | null>
  update(record: ApiKeyRecord): Promise<ApiKeyRecord>
  findByIdForUser(id: string, userId: string): Promise<ApiKeyRecord | null>
  findByHashPrefix(prefix: string): Promise<ApiKeyRecord[]>
  reset(): Promise<void>
}

const API_KEY_PREFIX = 'dsk'
const HASH_PREFIX_LENGTH = 12
const memoryApiKeys = new Map<string, ApiKeyRecord>()

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

// Argon2id parameters tuned per docs/api-keys.md (memory in KiB)
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 1 << 16, // 65536 KiB = 64 MiB
  timeCost: 3,
  parallelism: 1,
}

const getHashPrefix = (hash: string): string => hash.slice(0, HASH_PREFIX_LENGTH)

const buildApiKeyValue = (id: string, secret: string): string => `${API_KEY_PREFIX}_${id}.${secret}`

const parseApiKey = (apiKey: string): { apiKeyId: string; secret: string } | null => {
  const match = new RegExp(`^${API_KEY_PREFIX}_([^\\.]+)\\.(.+)$`).exec(apiKey.trim())
  if (!match) {
    return null
  }

  return { apiKeyId: match[1], secret: match[2] }
}

const normalizeScopes = (scopes: string[]): string[] => {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).sort()
}

const normalizeScopeColumn = (scopes: string[] | string | null): string[] => {
  if (Array.isArray(scopes)) {
    return normalizeScopes(scopes)
  }

  if (typeof scopes !== 'string' || !scopes.trim()) {
    return []
  }

  return normalizeScopes(
    scopes
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
  )
}

const redactApiKeyForLogs = (apiKey: string | undefined): string => {
  if (!apiKey) {
    return 'none'
  }

  const parsed = parseApiKey(apiKey)
  if (!parsed) {
    return 'invalid-format'
  }

  return `${API_KEY_PREFIX}_${parsed.apiKeyId}.***`
}

const asIsoString = (value: string | Date | null): string | null => {
  if (!value) {
    return null
  }

  return typeof value === 'string' ? value : value.toISOString()
}

const toRecord = (row: ApiKeyRow): ApiKeyRecord => ({
  id: row.id,
  userId: row.user_id,
  orgId: row.org_id,
  keyHash: row.key_hash,
  label: row.label,
  scopes: normalizeScopeColumn(row.scopes),
  createdAt: asIsoString(row.created_at)!,
  revokedAt: asIsoString(row.revoked_at),
})

const cloneRecord = (record: ApiKeyRecord): ApiKeyRecord => ({
  ...record,
  scopes: [...record.scopes],
})

const createMemoryRepository = (): ApiKeyRepository => ({
  async create(record) {
    memoryApiKeys.set(record.id, cloneRecord(record))
  },
  async listForUser(userId) {
    return Array.from(memoryApiKeys.values())
      .filter((record) => record.userId === userId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(cloneRecord)
  },
  async getById(id) {
    const record = memoryApiKeys.get(id)
    return record ? cloneRecord(record) : null
  },
  async update(record) {
    memoryApiKeys.set(record.id, cloneRecord(record))
    return cloneRecord(record)
  },
  async findByIdForUser(id, userId) {
    const record = memoryApiKeys.get(id)
    if (!record || record.userId !== userId) {
      return null
    }
    return cloneRecord(record)
  },
  async findByHashPrefix(prefix) {
    return Array.from(memoryApiKeys.values())
      .filter((record) => getHashPrefix(record.keyHash) === prefix)
      .map(cloneRecord)
  },
  async reset() {
    memoryApiKeys.clear()
  },
})

const createPgRepository = (pool: Pool): ApiKeyRepository => ({
  async create(record) {
    await pool.query(
      `INSERT INTO api_keys (id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, $6::text[], $7::timestamptz, $8::timestamptz)`,
      [
        record.id,
        record.userId,
        record.orgId,
        record.keyHash,
        record.label,
        record.scopes,
        record.createdAt,
        record.revokedAt,
      ],
    )
  },
  async listForUser(userId) {
    const result = await pool.query<ApiKeyRow>(
      `SELECT id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    )

    return result.rows.map(toRecord)
  },
  async getById(id) {
    const result = await pool.query<ApiKeyRow>(
      `SELECT id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at
       FROM api_keys
       WHERE id = $1
       LIMIT 1`,
      [id],
    )

    return result.rows[0] ? toRecord(result.rows[0]) : null
  },
  async update(record) {
    const result = await pool.query<ApiKeyRow>(
      `UPDATE api_keys
       SET user_id = $2,
           org_id = $3,
           key_hash = $4,
           label = $5,
           scopes = $6::text[],
           created_at = $7::timestamptz,
           revoked_at = $8::timestamptz
       WHERE id = $1
       RETURNING id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at`,
      [
        record.id,
        record.userId,
        record.orgId,
        record.keyHash,
        record.label,
        record.scopes,
        record.createdAt,
        record.revokedAt,
      ],
    )

    return toRecord(result.rows[0])
  },
  async findByIdForUser(id, userId) {
    const result = await pool.query<ApiKeyRow>(
      `SELECT id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at
       FROM api_keys
       WHERE id = $1 AND user_id = $2
       LIMIT 1`,
      [id, userId],
    )

    return result.rows[0] ? toRecord(result.rows[0]) : null
  },
  async findByHashPrefix(prefix) {
    const result = await pool.query<ApiKeyRow>(
      `SELECT id, user_id, org_id, key_hash, label, scopes, created_at, revoked_at
       FROM api_keys
       WHERE left(key_hash, $1) = $2`,
      [HASH_PREFIX_LENGTH, prefix],
    )

    return result.rows.map(toRecord)
  },
  async reset() {
    await pool.query('DELETE FROM api_keys')
  },
})

let repositoryOverride: ApiKeyRepository | null = null

const getRepository = (): ApiKeyRepository => {
  if (repositoryOverride) {
    return repositoryOverride
  }

  const pool = getPgPool()
  return pool ? createPgRepository(pool) : createMemoryRepository()
}

const createApiKeyRecord = async (input: CreateApiKeyInput, secret: string): Promise<ApiKeyRecord> => {
  const fingerprint = hashSecret(secret)
  const argonHash = await argon2.hash(secret, ARGON2_OPTIONS)

  return {
    id: randomUUID(),
    userId: input.userId ?? null,
    orgId: input.orgId ?? null,
    // Store as: <sha256hex>$argon2id$<argon2hash> so existing left(key_hash,12) prefix index remains useful
    keyHash: `${fingerprint}$argon2id$${argonHash}`,
    label: input.label.trim(),
    scopes: normalizeScopes(input.scopes),
    createdAt: utcNow(),
    revokedAt: null,
  }
}

const findMatchingRecord = async (apiKey: string): Promise<{ record: ApiKeyRecord; secret: string } | null> => {
  const parsed = parseApiKey(apiKey)
  if (!parsed) {
    return null
  }

  const secretHash = hashSecret(parsed.secret)
  const hashPrefix = getHashPrefix(secretHash)
  const candidates = await getRepository().findByHashPrefix(hashPrefix)

  for (const candidate of candidates) {
    if (candidate.id !== parsed.apiKeyId) continue

    const stored = candidate.keyHash

    // New format: <fingerprint>$argon2id$<argonHash>
    if (stored.includes('$argon2id$')) {
      const parts = stored.split('$argon2id$')
      const fingerprintPart = parts[0]
      const argonPart = parts.slice(1).join('$argon2id$')

      if (fingerprintPart === secretHash) {
        try {
          const ok = await argon2.verify(argonPart, parsed.secret)
          if (ok) return { record: candidate, secret: parsed.secret }
        } catch (_e) {
          // verify failure -> continue
        }
      }
      continue
    }

    // Legacy store: plain sha256 fingerprint
    if (stored === secretHash) {
      // Rolling re-hash: create argon2 and persist combined format
      const argonHash = await argon2.hash(parsed.secret, ARGON2_OPTIONS)
      candidate.keyHash = `${secretHash}$argon2id$${argonHash}`
      // best-effort update; do not fail validation if update fails
      try {
        await getRepository().update(candidate)
      } catch (_err) {
        // ignore
      }

      return { record: candidate, secret: parsed.secret }
    }
  }

  return null
}

export const createApiKey = async (
  input: CreateApiKeyInput,
): Promise<{ apiKey: string; record: ApiKeyRecord }> => {
  const secret = randomBytes(32).toString('hex')
  const record = await createApiKeyRecord(input, secret)
  await getRepository().create(record)

  return {
    apiKey: buildApiKeyValue(record.id, secret),
    record: cloneRecord(record),
  }
}

export const listApiKeysForUser = async (userId: string): Promise<ApiKeyRecord[]> => {
  return getRepository().listForUser(userId)
}

export const revokeApiKey = async (apiKeyId: string, userId: string): Promise<ApiKeyRecord | null> => {
  const record = await getRepository().findByIdForUser(apiKeyId, userId)
  if (!record) {
    return null
  }

  if (!record.revokedAt) {
    record.revokedAt = utcNow()
    await getRepository().update(record)
  }

  return cloneRecord(record)
}

export const rotateApiKey = async (
  input: RotateApiKeyInput,
): Promise<{ apiKey: string; record: ApiKeyRecord } | null> => {
  const record = await getRepository().findByIdForUser(input.apiKeyId, input.userId)
  if (!record || record.revokedAt) {
    return null
  }

  const nextSecret = randomBytes(32).toString('hex')
  const fingerprint = hashSecret(nextSecret)
  const argonHash = await argon2.hash(nextSecret, ARGON2_OPTIONS)
  record.keyHash = `${fingerprint}$argon2id$${argonHash}`
  record.createdAt = utcNow()
  record.revokedAt = null

  const updated = await getRepository().update(record)

  return {
    apiKey: buildApiKeyValue(updated.id, nextSecret),
    record: updated,
  }
}

export const validateApiKey = async (
  apiKey: string,
  requiredScopes: ApiScope[] = [],
): Promise<ApiKeyValidationResult> => {
  const parsed = parseApiKey(apiKey)
  if (!parsed) {
    return { valid: false, reason: 'malformed' }
  }

  const match = await findMatchingRecord(apiKey)
  if (!match) {
    return { valid: false, reason: 'invalid' }
  }

  const { record } = match

  if (record.revokedAt) {
    return { valid: false, reason: 'revoked' }
  }

  const normalizedRequiredScopes = normalizeScopes(requiredScopes as unknown as string[])
  const missingScope = normalizedRequiredScopes.find((scope) => !record.scopes.includes(scope))
  if (missingScope) {
    return { valid: false, reason: 'forbidden' }
  }

  return {
    valid: true,
    context: {
      apiKeyId: record.id,
      userId: record.userId,
      orgId: record.orgId,
      scopes: [...record.scopes],
      label: record.label,
    },
  }
}

export const resetApiKeysTable = async (): Promise<void> => {
  await getRepository().reset()
}

export const setApiKeyRepositoryForTests = (repository: ApiKeyRepository | null): void => {
  repositoryOverride = repository
}

export { redactApiKeyForLogs }
