/**
 * Unit tests for sanitizeReasonText – the pure PII-redaction helper exported
 * from src/routes/admin.ts.
 *
 * The function chains five sequential .replace() calls (email, card, SSN, IP,
 * token).  These tests confirm that:
 *   1. Each pattern fires individually.
 *   2. Multiple PII types present simultaneously are all redacted.
 *   3. Sequential replacements do not interact: a later regex does not re-match
 *      text inserted by an earlier replacement, and character-offset shifts
 *      caused by one substitution do not cause another to miss or over-match.
 *   4. Word-boundary anchors protect against partial matches inside longer
 *      digit strings.
 *   5. The 500-character output cap is enforced after all replacements.
 *
 * admin.ts has many heavy transitive dependencies (db pool, Prisma, etc.) that
 * are irrelevant to this pure function.  They are stubbed below so ts-jest
 * never attempts to compile or run them.
 */

// ── Stub every heavy dependency pulled in by admin.ts ──────────────────────
// These mocks must appear before any import that resolves to admin.ts so that
// Jest's module registry never loads (or compiles) the real implementations.

jest.mock('../db/index', () => ({ pool: {} }))
jest.mock('../db/knex', () => ({ db: { raw: jest.fn(), fn: {}, schema: {} } }))
jest.mock('../lib/audit-logs', () => ({
  createAuditLog: jest.fn(),
  exportAuditLogsForOrganization: jest.fn(),
  getAuditLogById: jest.fn(),
  listAuditLogs: jest.fn(),
  verifyAuditLogChain: jest.fn(),
}))
jest.mock('../lib/prismaScope', () => ({ getPrisma: jest.fn() }))
jest.mock('../lib/auth-utils', () => ({
  generateImpersonationToken: jest.fn(),
  generateAccessToken: jest.fn(),
  verifyAccessToken: jest.fn(),
}))
jest.mock('../middleware/rbac', () => ({ requireAdmin: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()) }))
jest.mock('../middleware/auth', () => ({ authenticate: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()) }))
jest.mock('../middleware/rateLimiter', () => ({ metricsRateLimiter: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()) }))
jest.mock('../middleware/stepUp', () => ({ requireStepUp: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()) }))
jest.mock('../middleware/queryParser', () => ({ queryParser: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()) }))
jest.mock('../middleware/confirmationToken', () => ({
  requireConfirmationToken: jest.fn(() => (_: unknown, __: unknown, next: () => void) => next()),
  issueConfirmationToken: jest.fn(),
  approveConfirmationToken: jest.fn(),
  isDualControlRequired: jest.fn(),
  VALID_DESTRUCTIVE_ACTIONS: [],
}))
jest.mock('../services/user.service', () => ({ userService: {}, DeleteResult: {} }))
jest.mock('../services/session', () => ({ forceRevokeUserSessions: jest.fn(), recordSession: jest.fn() }))
jest.mock('../services/vaultStore', () => ({ cancelVaultById: jest.fn() }))
jest.mock('../services/dbMetrics', () => ({ getDBHealthMetrics: jest.fn(), getSlowQueryBuffer: jest.fn() }))
jest.mock('../services/checkpointStore', () => ({ CheckpointStore: jest.fn() }))
jest.mock('../services/monitor', () => ({ getLatestListenerLag: jest.fn() }))
jest.mock('../services/evidenceReindex', () => ({ runReindexBatches: jest.fn(), EMBEDDING_REINDEX_JOB_NAME: '' }))
jest.mock('../repositories/milestoneRepository', () => ({ MilestoneRepository: jest.fn() }))
jest.mock('../services/backfillCursorStore', () => ({ BackfillCursorStore: jest.fn() }))
jest.mock('../services/transactionETL', () => ({ TransactionETLService: jest.fn() }))
jest.mock('../services/etlWorker', () => ({ resolveETLConfig: jest.fn() }))
jest.mock('../services/idempotency', () => ({ DbIdempotencyStore: jest.fn() }))
jest.mock('../security/abuse-monitor', () => ({ getAbuseCategoryCounts: jest.fn() }))
jest.mock('../services/featureFlags', () => ({ getFlag: jest.fn(), setFlag: jest.fn(), FeatureFlag: {}, isValidFeatureFlag: jest.fn() }))

import { sanitizeReasonText } from '../routes/admin.js'

// ── Individual pattern tests ─────────────────────────────────────────────────

describe('sanitizeReasonText – individual PII patterns', () => {
  it('redacts a bare email address', () => {
    expect(sanitizeReasonText('contact alice@example.com please'))
      .toBe('contact [REDACTED_EMAIL] please')
  })

  it('redacts a card number with dashes', () => {
    expect(sanitizeReasonText('card 4111-1111-1111-1111 on file'))
      .toBe('card [REDACTED_CARD] on file')
  })

  it('redacts a card number without dashes', () => {
    expect(sanitizeReasonText('card 4111111111111111 on file'))
      .toBe('card [REDACTED_CARD] on file')
  })

  it('redacts an SSN', () => {
    expect(sanitizeReasonText('ssn 123-45-6789 provided'))
      .toBe('ssn [REDACTED_SSN] provided')
  })

  it('redacts an IPv4 address', () => {
    expect(sanitizeReasonText('from 192.168.0.1 to server'))
      .toBe('from [REDACTED_IP] to server')
  })

  it('redacts a 32-character token', () => {
    const token = 'abcdefghijklmnopqrstuvwxyz123456' // exactly 32
    expect(sanitizeReasonText(`token: ${token} end`))
      .toBe('token: [REDACTED_TOKEN] end')
  })

  it('redacts a token longer than 32 characters', () => {
    const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop' // 42 chars
    expect(sanitizeReasonText(`bearer ${token}`))
      .toBe('bearer [REDACTED_TOKEN]')
  })
})

// ── Combined / simultaneous PII tests ────────────────────────────────────────

describe('sanitizeReasonText – combined PII redaction', () => {
  it('redacts all five PII types present in the same string', () => {
    // Each type is separated by whitespace so word-boundaries fire cleanly.
    // This locks in the baseline sequential-replacement output.
    const input = [
      'Email: alice@example.com',
      'token: abcdefghijklmnopqrstuvwxyzABCDEFG12345678',
      'IP: 192.168.0.1',
      'card: 4111-1111-1111-1111',
      'SSN: 123-45-6789',
    ].join(' ')

    expect(sanitizeReasonText(input)).toBe(
      'Email: [REDACTED_EMAIL] token: [REDACTED_TOKEN] IP: [REDACTED_IP] card: [REDACTED_CARD] SSN: [REDACTED_SSN]'
    )
  })

  it('redacts email and token that are adjacent with only a single space between them', () => {
    // Validates that the email regex does not consume the token's leading chars
    // and the token regex does not consume the email's trailing chars.
    const email = 'user@host.com'
    const token = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456' // 32 chars
    expect(sanitizeReasonText(`reason: ${email} ${token} end`))
      .toBe('reason: [REDACTED_EMAIL] [REDACTED_TOKEN] end')
  })

  it('replacement placeholders are NOT re-matched by the token regex (no double-redaction)', () => {
    // All replacement strings ([REDACTED_EMAIL] etc.) are < 32 chars and contain
    // non-alphanumeric characters ('[' and ']'), so /\b[A-Za-z0-9]{32,}\b/ cannot
    // match them.  Every placeholder must survive intact in the final output.
    const input = [
      'alice@example.com', // → [REDACTED_EMAIL]   (16 chars, brackets)
      '4111-1111-1111-1111', // → [REDACTED_CARD]    (15 chars)
      '123-45-6789', // → [REDACTED_SSN]     (14 chars)
      '10.0.0.1', // → [REDACTED_IP]      (13 chars)
      'abcdefghijklmnopqrstuvwxyz123456', // → [REDACTED_TOKEN]  (32 chars)
    ].join(' ')

    expect(sanitizeReasonText(input)).toBe(
      '[REDACTED_EMAIL] [REDACTED_CARD] [REDACTED_SSN] [REDACTED_IP] [REDACTED_TOKEN]'
    )
  })

  it('multiple occurrences of the same PII type are each redacted independently', () => {
    const input = 'from alice@example.com to bob@corp.io re 192.168.1.1 and 10.20.30.40'
    expect(sanitizeReasonText(input)).toBe(
      'from [REDACTED_EMAIL] to [REDACTED_EMAIL] re [REDACTED_IP] and [REDACTED_IP]'
    )
  })

  it('IP address embedded between card-like digit groups is redacted as IP only', () => {
    // '4111-192.168.0.1-1111': the card regex requires four 4-digit groups (with
    // optional dashes) — the '192' group breaks that pattern.  The IP regex then
    // matches '192.168.0.1' cleanly without consuming the outer digit fragments.
    const input = 'data: 4111-192.168.0.1-1111 end'
    expect(sanitizeReasonText(input)).toBe('data: 4111-[REDACTED_IP]-1111 end')
  })
})

// ── Word-boundary protection tests ───────────────────────────────────────────

describe('sanitizeReasonText – word-boundary anchors prevent over-matching', () => {
  it('does NOT redact an SSN-shaped sequence with a leading digit (no word boundary before)', () => {
    // '1123-45-6789': leading '1' means \b does not fire before '123'.
    expect(sanitizeReasonText('ref: 1123-45-6789 done'))
      .toBe('ref: 1123-45-6789 done')
  })

  it('does NOT redact an SSN-shaped sequence with a trailing digit (no word boundary after)', () => {
    // '123-45-67891': trailing '1' means \b does not fire after '6789'.
    expect(sanitizeReasonText('ref: 123-45-67891 done'))
      .toBe('ref: 123-45-67891 done')
  })

  it('does NOT redact a token-like string shorter than 32 characters', () => {
    const short = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ12345' // 31 chars
    expect(sanitizeReasonText(`key=${short}`)).toBe(`key=${short}`)
  })
})

// ── Length-cap test ───────────────────────────────────────────────────────────

describe('sanitizeReasonText – output length cap', () => {
  it('truncates output to at most 500 characters', () => {
    // Build a string long enough that even after redaction it would exceed 500
    // chars if the substring(0, 500) were missing.
    const manyEmails = Array.from({ length: 40 }, (_, i) => `u${i}@example.com`).join(' ')
    const out = sanitizeReasonText(manyEmails)
    expect(out.length).toBeLessThanOrEqual(500)
  })

  it('does not truncate strings that are already within 500 characters', () => {
    const short = 'clean reason text'
    expect(sanitizeReasonText(short)).toBe(short)
  })
})
