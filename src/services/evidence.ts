import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { prisma } from '../lib/prisma.js'

export class EvidenceReferenceValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EvidenceReferenceValidationError'
  }
}

export interface EvidenceReference {
  id: string
  verificationId: string
  evidenceHash: string
  referenceUrl: string
  expiresAt: string
  createdAt: string
}

const EVIDENCE_HASH_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
const METADATA_IP = '169.254.169.254'

export interface DnsLookupAddress {
  address: string
  family: number
}

export type EvidenceDnsResolver = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<DnsLookupAddress[]>

function getEvidenceAllowedHosts(): string[] {
  return (process.env.EVIDENCE_ALLOWED_HOSTS ?? process.env.WEBHOOK_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().replace(/\.$/, '').toLowerCase())
    .filter(Boolean)
}

function normalizeHostname(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
}

function normalizeIpv4MappedAddress(address: string): string {
  const normalized = normalizeHostname(address)
  const dottedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (dottedMatch) return dottedMatch[1]

  const hexMatch = normalized.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (!hexMatch) return normalized

  const high = Number.parseInt(hexMatch[1], 16)
  const low = Number.parseInt(hexMatch[2], 16)
  return [
    String((high >> 8) & 255),
    String(high & 255),
    String((low >> 8) & 255),
    String(low & 255),
  ].join('.')
}

function isBlockedIpAddress(address: string): boolean {
  const normalized = normalizeIpv4MappedAddress(address)

  if (isIP(normalized) === 4) {
    return (
      normalized === METADATA_IP ||
      /^0\./.test(normalized) ||
      /^10\./.test(normalized) ||
      /^127\./.test(normalized) ||
      /^169\.254\./.test(normalized) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(normalized) ||
      /^192\.168\./.test(normalized)
    )
  }

  if (isIP(normalized) === 6) {
    if (normalized === '::1') return true
    const firstGroup = Number.parseInt(normalized.split(':')[0] || '0', 16)
    return (firstGroup & 0xfe00) === 0xfc00 || (firstGroup & 0xffc0) === 0xfe80
  }

  return false
}

function isAllowedEvidenceHost(hostname: string, allowedHosts = getEvidenceAllowedHosts()): boolean {
  if (allowedHosts.length === 0) return true
  return allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

export async function validateEvidenceReferenceUrlSafety(
  referenceUrl: string,
  resolver: EvidenceDnsResolver = lookup,
): Promise<void> {
  let url: URL
  try {
    url = new URL(referenceUrl)
  } catch {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must be a valid URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must use http or https')
  }

  const hostname = normalizeHostname(url.hostname)
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    /(?:^|\.)localtest\.me$/.test(hostname)
  ) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl host is not permitted')
  }

  if (!isAllowedEvidenceHost(hostname)) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl host is not allowlisted')
  }

  if (isIP(hostname) !== 0) {
    if (isBlockedIpAddress(hostname)) {
      throw new EvidenceReferenceValidationError('evidenceReferenceUrl resolves to a private or internal address')
    }
    return
  }

  let resolved: DnsLookupAddress[]
  try {
    resolved = await resolver(hostname, { all: true, verbatim: true })
  } catch {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl host did not resolve')
  }
  if (resolved.length === 0) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl host did not resolve')
  }

  for (const record of resolved) {
    if (isBlockedIpAddress(record.address)) {
      throw new EvidenceReferenceValidationError('evidenceReferenceUrl resolves to a private or internal address')
    }
  }
}

function normalizeEvidenceHash(input: unknown): string {
  if (typeof input !== 'string') {
    throw new EvidenceReferenceValidationError('evidenceHash must be a string')
  }

  const hash = input.trim()
  if (!EVIDENCE_HASH_PATTERN.test(hash)) {
    throw new EvidenceReferenceValidationError('evidenceHash must be a valid reference hash')
  }

  return hash
}

function parseAwsDate(dateString: string): Date {
  const normalized = dateString.toUpperCase()
  if (!/^[0-9]{8}T[0-9]{6}Z$/.test(normalized)) {
    throw new EvidenceReferenceValidationError('Invalid AWS signed URL date format')
  }

  const year = Number(normalized.slice(0, 4))
  const month = Number(normalized.slice(4, 6))
  const day = Number(normalized.slice(6, 8))
  const hour = Number(normalized.slice(9, 11))
  const minute = Number(normalized.slice(11, 13))
  const second = Number(normalized.slice(13, 15))
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second))
}

function parseExpiryParam(value: string): Date {
  const normalized = value.trim()
  if (normalized === '') {
    throw new EvidenceReferenceValidationError('Signed URL expiry parameter is empty')
  }

  const epoch = Number(normalized)
  if (Number.isFinite(epoch) && epoch > 0) {
    // Support epoch seconds and milliseconds
    const millis = epoch > 1e11 ? epoch : epoch * 1000
    return new Date(millis)
  }

  throw new EvidenceReferenceValidationError('Signed URL expiry parameter must be a valid numeric timestamp')
}

function getSignedUrlExpiry(referenceUrl: string): Date {
  let url: URL
  try {
    url = new URL(referenceUrl)
  } catch (error) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must be a valid URL')
  }

  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new EvidenceReferenceValidationError('evidenceReferenceUrl must use http or https')
  }

  const params = url.searchParams
  const rawXAmzExpires = params.get('X-Amz-Expires')
  const rawExpires = params.get('Expires')
  const rawExpiresAlternate = params.get('expires')

  if (rawXAmzExpires) {
    const signedDate = params.get('X-Amz-Date')
    if (!signedDate) {
      throw new EvidenceReferenceValidationError('Missing X-Amz-Date for signed object-storage URL')
    }

    const baseDate = parseAwsDate(signedDate)
    const expirySeconds = Number(rawXAmzExpires)
    if (!Number.isFinite(expirySeconds) || expirySeconds < 0) {
      throw new EvidenceReferenceValidationError('Invalid X-Amz-Expires value')
    }

    return new Date(baseDate.getTime() + expirySeconds * 1000)
  }

  if (rawExpires) {
    return parseExpiryParam(rawExpires)
  }

  if (rawExpiresAlternate) {
    return parseExpiryParam(rawExpiresAlternate)
  }

  throw new EvidenceReferenceValidationError('Signed object-storage URL missing expiry parameter')
}

export function validateSignedObjectStorageUrl(referenceUrl: string): Date {
  const expiry = getSignedUrlExpiry(referenceUrl)
  if (expiry.getTime() <= Date.now()) {
    throw new EvidenceReferenceValidationError('Signed object-storage URL has already expired')
  }
  return expiry
}

export async function createEvidenceReference(
  verificationId: string,
  evidenceHash: string,
  evidenceReferenceUrl: string,
): Promise<EvidenceReference> {
  const normalizedHash = normalizeEvidenceHash(evidenceHash)
  const normalizedReferenceUrl = evidenceReferenceUrl.trim()
  const expiresAt = validateSignedObjectStorageUrl(normalizedReferenceUrl)
  await validateEvidenceReferenceUrlSafety(normalizedReferenceUrl)
  const now = new Date()

  const rows = await prisma.$queryRaw<
    Array<{
      id: string
      verification_id: string
      evidence_hash: string
      reference_url: string
      expires_at: Date
      created_at: Date
    }>
  >`
    INSERT INTO evidence_references (
      verification_id,
      evidence_hash,
      reference_url,
      expires_at,
      created_at
    ) VALUES (
      ${verificationId},
      ${normalizedHash},
      ${normalizedReferenceUrl},
      ${expiresAt},
      ${now}
    )
    ON CONFLICT (verification_id)
    DO UPDATE SET
      evidence_hash = excluded.evidence_hash,
      reference_url = excluded.reference_url,
      expires_at = excluded.expires_at
    RETURNING id, verification_id, evidence_hash, reference_url, expires_at, created_at
  `

  const [row] = rows
  if (!row) {
    throw new Error('Failed to persist evidence reference')
  }

  return {
    id: row.id,
    verificationId: row.verification_id,
    evidenceHash: row.evidence_hash,
    referenceUrl: row.reference_url,
    expiresAt: row.expires_at.toISOString(),
    createdAt: row.created_at.toISOString(),
  }
}
