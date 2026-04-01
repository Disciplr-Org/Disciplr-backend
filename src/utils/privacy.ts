import { createHash } from 'node:crypto';

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