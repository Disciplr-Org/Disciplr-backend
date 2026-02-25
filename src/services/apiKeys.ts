import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ApiKeyAuthContext, ApiKeyRecord } from '../types/auth.js'

interface CreateApiKeyInput {
  userId?: string
  orgId?: string
  label: string
  scopes: string[]
}

const apiKeysTable: ApiKeyRecord[] = []

const hashSecret = (secret: string): string => createHash('sha256').update(secret).digest('hex')

const normalizeScopes = (scopes: string[]): string[] => {
  return Array.from(new Set(scopes.map((scope) => scope.trim()).filter(Boolean))).sort()
}

export const createApiKey = (input: CreateApiKeyInput): { apiKey: string; record: ApiKeyRecord } => {
  const id = randomUUID()
  const secret = randomBytes(32).toString('hex')
  const createdAt = new Date().toISOString()

  const record: ApiKeyRecord = {
    id,
    userId: input.userId ?? null,
    orgId: input.orgId ?? null,
    keyHash: hashSecret(secret),
    label: input.label,
    scopes: normalizeScopes(input.scopes),
    createdAt,
    revokedAt: null,
  }

  apiKeysTable.push(record)

  return {
    apiKey: `dsk_${id}.${secret}`,
    record,
  }
}

export const listApiKeysForUser = (userId: string): ApiKeyRecord[] => {
  return apiKeysTable.filter((record) => record.userId === userId)
}

export const revokeApiKey = (apiKeyId: string, userId: string): ApiKeyRecord | null => {
  const record = apiKeysTable.find((entry) => entry.id === apiKeyId && entry.userId === userId)
  if (!record) {
    return null
  }

  if (!record.revokedAt) {
    record.revokedAt = new Date().toISOString()
  }

  return record
}

export const validateApiKey = (
  apiKey: string,
  requiredScopes: string[] = [],
): { valid: true; context: ApiKeyAuthContext } | { valid: false; reason: 'malformed' | 'invalid' | 'revoked' | 'forbidden' } => {
  const match = /^dsk_([^\.]+)\.(.+)$/.exec(apiKey.trim())
  if (!match) {
    return { valid: false, reason: 'malformed' }
  }

  const [, apiKeyId, secret] = match
  const record = apiKeysTable.find((entry) => entry.id === apiKeyId)
  if (!record) {
    return { valid: false, reason: 'invalid' }
  }

  if (record.revokedAt) {
    return { valid: false, reason: 'revoked' }
  }

  if (hashSecret(secret) !== record.keyHash) {
    return { valid: false, reason: 'invalid' }
  }

  const missingScope = requiredScopes.find((scope) => !record.scopes.includes(scope))
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

export const resetApiKeysTable = (): void => {
  apiKeysTable.length = 0
}
