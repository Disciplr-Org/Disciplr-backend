import { readFileSync } from 'node:fs'
import path from 'node:path'

import {
  LATEST_SCHEMA_VERSION,
  DEFAULT_SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  KNOWN_EVENT_TYPES,
} from '../services/webhooks.js'

const docPath = path.resolve(process.cwd(), 'docs/webhook-integration-guide.md')

describe('docs/webhook-integration-guide.md', () => {
  let contents: string

  beforeAll(() => {
    contents = readFileSync(docPath, 'utf8')
  })

  it('exists and is non-empty', () => {
    expect(contents.length).toBeGreaterThan(0)
  })

  // ── Header names ───────────────────────────────────────────────────────────

  it('documents the x-disciplr-signature header', () => {
    expect(contents).toMatch(/x-disciplr-signature/)
  })

  it('documents the x-disciplr-event header', () => {
    expect(contents).toMatch(/x-disciplr-event/)
  })

  it('documents the x-disciplr-event-id header', () => {
    expect(contents).toMatch(/x-disciplr-event-id/)
  })

  it('documents the x-disciplr-delivery-timestamp header', () => {
    expect(contents).toMatch(/x-disciplr-delivery-timestamp/)
  })

  // ── Signature scheme ───────────────────────────────────────────────────────

  it('describes HMAC-SHA256 as the signing algorithm', () => {
    expect(contents).toMatch(/HMAC-SHA256/i)
  })

  it('shows the sha256= digest prefix format', () => {
    expect(contents).toMatch(/sha256=</)
  })

  it('includes a Node.js verification example', () => {
    expect(contents).toContain('createHmac')
    expect(contents).toContain('timingSafeEqual')
  })

  it('includes a Python verification example', () => {
    expect(contents).toContain('hmac.compare_digest')
  })

  // ── Schema versions ────────────────────────────────────────────────────────

  it(`documents the current LATEST_SCHEMA_VERSION (${LATEST_SCHEMA_VERSION})`, () => {
    expect(contents).toMatch(new RegExp(`Latest:\\s*\`?${LATEST_SCHEMA_VERSION}\`?`))
  })

  it(`documents the current DEFAULT_SCHEMA_VERSION (${DEFAULT_SCHEMA_VERSION})`, () => {
    expect(contents).toMatch(new RegExp(`Default:\\s*\`?${DEFAULT_SCHEMA_VERSION}\`?`))
  })

  it('documents all supported schema versions', () => {
    for (const v of SUPPORTED_SCHEMA_VERSIONS) {
      expect(contents).toMatch(new RegExp(`Version\\s+${v}`))
    }
  })

  // ── Event types ────────────────────────────────────────────────────────────

  it('documents all known event types', () => {
    for (const eventType of KNOWN_EVENT_TYPES) {
      expect(contents).toContain(eventType)
    }
  })

  // ── Retry / backoff ────────────────────────────────────────────────────────

  it('documents the max 3 retry attempts', () => {
    expect(contents).toMatch(/3.*attempt/i)
  })

  it('documents the 1,000 ms initial backoff', () => {
    expect(contents).toContain('1,000')
  })

  it('documents the 2x backoff multiplier', () => {
    expect(contents).toMatch(/2[×x]/)
  })

  it('documents the 30,000 ms max backoff', () => {
    expect(contents).toContain('30,000')
  })

  it('documents the ±25 % jitter', () => {
    expect(contents).toContain('25')
  })

  // ── Dead-letter / replay ───────────────────────────────────────────────────

  it('references the dead-letter queue', () => {
    expect(contents).toMatch(/dead.letter/i)
  })

  it('documents the replay endpoint', () => {
    expect(contents).toContain('dead-letters/:id/replay')
  })

  // ── Test-ping ──────────────────────────────────────────────────────────────

  it('documents the test-ping endpoint path', () => {
    expect(contents).toContain('/api/webhooks/:id/test')
  })

  it('documents the test-ping synthetic payload shape', () => {
    expect(contents).toContain('webhook.test')
  })

  // ── Idempotency pattern ────────────────────────────────────────────────────

  it('recommends deduplication by x-disciplr-event-id', () => {
    expect(contents).toMatch(/idempotent/i)
    expect(contents).toContain('x-disciplr-event-id')
  })

  // ── Field masking ──────────────────────────────────────────────────────────

  it('documents field masking and PII stripping', () => {
    expect(contents).toMatch(/field\s*masking/i)
    expect(contents).toMatch(/PII/i)
  })

  // ── Circuit breaker ────────────────────────────────────────────────────────

  it('documents the circuit breaker states', () => {
    expect(contents).toContain('CLOSED')
    expect(contents).toContain('OPEN')
    expect(contents).toContain('HALF_OPEN')
  })

  // ── Secret rotation ────────────────────────────────────────────────────────

  it('documents the secret rotation grace window', () => {
    expect(contents).toMatch(/grace\s*window/i)
    expect(contents).toContain('24 hours')
  })
})
