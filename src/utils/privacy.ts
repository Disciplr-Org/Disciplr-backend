import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const STELLAR_ACCOUNT_PATTERN = /\bG[A-Z2-7]{55}\b/g;
const PII_FIELD_NAMES = new Set([
  'creator',
  'creatoraddress',
  'email',
  'failuredestination',
  'requesteruserid',
  'successdestination',
  'targetuserid',
  'userid',
]);

/**
 * Masks sensitive information using a deterministic one-way hash.
 * As per security requirements, it uses the first 8 characters of a SHA-256 hash.
 * Used for logging and metrics to prevent PII leakage while maintaining traceability.
 */
export function maskPii(value: string | undefined | null): string {
  if (!value) return 'anonymous';
  
  return createHash('sha256')
    .update(value)
    .digest('hex')
    .substring(0, 8);
}

const normalizePrivacyKey = (key: string): string => key.replace(/[_-]/g, '').toLowerCase();

const knownPiiTokens = (values: readonly unknown[]): string[] => {
  return Array.from(
    new Set(
      values
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .sort((left, right) => right.length - left.length),
    ),
  );
};

export function isPrivacySensitiveField(key: string): boolean {
  return PII_FIELD_NAMES.has(normalizePrivacyKey(key));
}

export function sanitizePrivacyString(value: string, knownPiiValues: readonly unknown[] = []): string {
  let sanitized = value;

  for (const token of knownPiiTokens(knownPiiValues)) {
    sanitized = sanitized.split(token).join(maskPii(token));
  }

  return sanitized
    .replace(EMAIL_PATTERN, (match) => maskPii(match))
    .replace(STELLAR_ACCOUNT_PATTERN, (match) => maskPii(match));
}

export function sanitizePrivacyPayload(value: unknown, knownPiiValues: readonly unknown[] = [], seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    return sanitizePrivacyString(value, knownPiiValues);
  }

  if (typeof value !== 'object') {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Buffer.isBuffer(value)) {
    return '[Buffer]';
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizePrivacyPayload(item, knownPiiValues, seen));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (isPrivacySensitiveField(key) && typeof entryValue !== 'object') {
      sanitized[key] = maskPii(String(entryValue));
      continue;
    }

    sanitized[key] = sanitizePrivacyPayload(entryValue, knownPiiValues, seen);
  }

  return sanitized;
}
