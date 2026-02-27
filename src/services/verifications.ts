import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto'

type ValidationVerdict = 'approved' | 'rejected'

export interface ValidationPayload {
  vaultId: string
  milestoneId: string
  verdict: ValidationVerdict
  reason?: string
  evidence: {
    mimeType: string
    data: string
  }
}

interface EncryptedEvidenceRecord {
  algorithm: 'aes-256-gcm'
  keyId: string
  iv: string
  authTag: string
  ciphertext: string
  mimeType: string
  sizeBytes: number
}

export interface ValidationTransactionRecord {
  id: string
  vaultId: string
  milestoneId: string
  verdict: ValidationVerdict
  reason?: string
  verifierId: string
  createdAt: string
  idempotencyKey: string
  idempotencyDigest: string
  evidence: EncryptedEvidenceRecord
}

export class IdempotencyConflictError extends Error {
  constructor(message = 'Idempotency key already used with a different payload') {
    super(message)
    this.name = 'IdempotencyConflictError'
  }
}

const validationTransactions: ValidationTransactionRecord[] = []
const idempotencyIndex = new Map<string, { payloadDigest: string; recordId: string }>()

const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }

  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`
}

const getEncryptionKey = (): { key: Buffer; keyId: string } => {
  const configured = process.env.EVIDENCE_ENCRYPTION_KEY?.trim()
  const key = configured
    ? createHash('sha256').update(configured, 'utf8').digest()
    : createHash('sha256').update('disciplr-dev-only-change-me', 'utf8').digest()
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16)
  return { key, keyId }
}

const encryptEvidence = (evidence: ValidationPayload['evidence']): EncryptedEvidenceRecord => {
  const { key, keyId } = getEncryptionKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const serializedEvidence = JSON.stringify(evidence)
  const encrypted = Buffer.concat([cipher.update(serializedEvidence, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()

  return {
    algorithm: 'aes-256-gcm',
    keyId,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    mimeType: evidence.mimeType,
    sizeBytes: Buffer.byteLength(evidence.data, 'utf8'),
  }
}

export const createValidationTransaction = (
  payload: ValidationPayload,
  verifierId: string,
  idempotencyKey: string,
): { record: ValidationTransactionRecord; replayed: boolean } => {
  const normalizedKey = idempotencyKey.trim()
  const payloadDigest = createHash('sha256').update(stableStringify(payload), 'utf8').digest('hex')
  const existing = idempotencyIndex.get(normalizedKey)

  if (existing) {
    if (existing.payloadDigest !== payloadDigest) {
      throw new IdempotencyConflictError()
    }

    const existingRecord = validationTransactions.find((entry) => entry.id === existing.recordId)
    if (!existingRecord) {
      throw new Error('Idempotency index is inconsistent')
    }

    return { record: existingRecord, replayed: true }
  }

  const record: ValidationTransactionRecord = {
    id: randomUUID(),
    vaultId: payload.vaultId,
    milestoneId: payload.milestoneId,
    verdict: payload.verdict,
    reason: payload.reason,
    verifierId,
    createdAt: new Date().toISOString(),
    idempotencyKey: normalizedKey,
    idempotencyDigest: payloadDigest,
    evidence: encryptEvidence(payload.evidence),
  }

  validationTransactions.push(record)
  idempotencyIndex.set(normalizedKey, { payloadDigest, recordId: record.id })

  return { record, replayed: false }
}

export const listValidationTransactions = (): ValidationTransactionRecord[] => {
  return [...validationTransactions]
}

export const findValidationTransactionById = (id: string): ValidationTransactionRecord | undefined => {
  return validationTransactions.find((entry) => entry.id === id)
}

export const resetValidationTransactions = (): void => {
  validationTransactions.length = 0
  idempotencyIndex.clear()
}

export const decryptEvidenceForTesting = (record: ValidationTransactionRecord): ValidationPayload['evidence'] => {
  const { key } = getEncryptionKey()
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(record.evidence.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(record.evidence.authTag, 'base64'))
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(record.evidence.ciphertext, 'base64')),
    decipher.final(),
  ])
  return JSON.parse(decrypted.toString('utf8')) as ValidationPayload['evidence']
}
