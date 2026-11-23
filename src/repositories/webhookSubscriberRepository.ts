import { Knex } from 'knex'
import type { WebhookSubscriber, BreakerState, BreakerStateValue } from '../services/webhooks.js'
import { FieldPolicy, parseFieldPolicy, DEFAULT_FIELD_POLICY } from '../utils/webhookFieldMasking.js'
import { encryptField, decryptField, isEncrypted, DecryptionError } from '../lib/encryption.js'

export interface DeliveryStats {
  attempt_count: number
  success_count: number
  failure_count: number
  success_rate: number
  p50_latency_ms: number | null
  p95_latency_ms: number | null
  last_failure_reason: string | null
  breaker_state: BreakerStateValue | null
}

interface SubscriberRow {
  id: string
  organization_id: string
  url: string
  secret: string
  previous_secret: string | null
  rotated_at: Date | null
  events: string | string[]
  active: boolean
  schema_version: number
  field_policy: unknown
  created_at: Date
  updated_at: Date
}

interface BreakerRow {
  subscriber_id: string
  state: string
  failure_count: number
  last_failure_at: Date | null
  tripped_at: Date | null
  half_open_at: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * Sentinel value stored as the secret when decryption fails, signalling that
 * the subscriber needs operator attention (e.g. key rotation recovery).
 */
const DECRYPTION_FAILED_SENTINEL = '[DECRYPTION_FAILED]'

/**
 * Decrypts a stored secret column for in-memory use.
 *
 * Signing secrets are encrypted at rest (AES-256-GCM). During the rollout
 * window a column may still hold a legacy plaintext value written before this
 * feature existed; such values are passed through unchanged and will be
 * re-encrypted on their next write. Anything that *looks* encrypted is
 * decrypted strictly — a {@link DecryptionError} is caught per-row and the
 * sentinel value is returned so a single corrupted row never takes down the
 * entire batch.
 */
function decryptSecretColumn(value: string | null, subscriberId: string, column: 'secret' | 'previous_secret' = 'secret'): string | null {
  if (value === null) return null
  if (!isEncrypted(value)) return value
  try {
    return decryptField(value)
  } catch (err) {
    if (err instanceof DecryptionError) {
      console.error(
        `[WebhookSubscriberRepo] ${column} decryption failed for subscriber ${subscriberId}, using sentinel value`,
        err,
      )
      return DECRYPTION_FAILED_SENTINEL
    }
    throw err
  }
}

function toSubscriber(row: SubscriberRow): WebhookSubscriber {
  const secret = decryptSecretColumn(row.secret, row.id) ?? DECRYPTION_FAILED_SENTINEL
  const decryptedPrev = decryptSecretColumn(row.previous_secret, row.id, 'previous_secret')
  const previousSecret = decryptedPrev === DECRYPTION_FAILED_SENTINEL ? null : decryptedPrev

  return {
    id: row.id,
    organizationId: row.organization_id,
    url: row.url,
    secret,
    previousSecret,
    rotatedAt: row.rotated_at instanceof Date
      ? row.rotated_at.toISOString()
      : (row.rotated_at ? String(row.rotated_at) : null),
    events: (() => {
      const parsed = typeof row.events === 'string'
        ? (() => {
            try {
              const parsedJson = JSON.parse(row.events)
              return Array.isArray(parsedJson) ? parsedJson : []
            } catch {
              return []
            }
          })()
        : row.events ?? []
      return parsed
    })(),
    active: row.active,
    schemaVersion: row.schema_version ?? 1,
    fieldPolicy: parseFieldPolicy(row.field_policy, row.id),
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
  }
}

function toBreakerState(row: BreakerRow): BreakerState {
  return {
    subscriberId: row.subscriber_id,
    state: row.state as BreakerStateValue,
    failureCount: row.failure_count,
    lastFailureAt: row.last_failure_at instanceof Date
      ? row.last_failure_at.toISOString()
      : row.last_failure_at,
    trippedAt: row.tripped_at instanceof Date
      ? row.tripped_at.toISOString()
      : row.tripped_at,
    halfOpenAt: row.half_open_at instanceof Date
      ? row.half_open_at.toISOString()
      : row.half_open_at,
    createdAt: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    updatedAt: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : String(row.updated_at),
  }
}

export class WebhookSubscriberRepository {
  constructor(private readonly db: Knex) {}

  async findByOrg(organizationId: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async findById(id: string): Promise<WebhookSubscriber | null> {
    const row = await this.db<SubscriberRow>('webhook_subscribers').where({ id }).first()
    return row ? toSubscriber(row) : null
  }

  async findByEvent(organizationId: string, eventType: string): Promise<WebhookSubscriber[]> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ organization_id: organizationId, active: true })
      .andWhere(function () {
        this.whereRaw("events = '[]'::jsonb").orWhereRaw('events @> ?', [
          JSON.stringify([eventType]),
        ])
      })
      .orderBy('created_at', 'asc')
    return rows.map(toSubscriber)
  }

  async create(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
    schemaVersion?: number
    fieldPolicy?: FieldPolicy
  }): Promise<WebhookSubscriber> {
    const [row] = await this.db<SubscriberRow>('webhook_subscribers')
      .insert({
        organization_id: data.organizationId,
        url: data.url,
        secret: encryptField(data.secret),
        events: JSON.stringify(data.events),
        schema_version: data.schemaVersion ?? 1,
        field_policy: JSON.stringify(data.fieldPolicy ?? DEFAULT_FIELD_POLICY),
      })
      .returning('*')
    return toSubscriber(row)
  }

  /**
   * Idempotent upsert keyed on (organization_id, url).
   *
   * - If no row exists for the (org, url) pair a new subscriber is inserted.
   * - If a row already exists the `secret`, `events`, and `active` fields are
   *   updated in-place so the caller does not end up with duplicate rows.
   * - Cross-org overwrites are impossible: the WHERE clause in the ON CONFLICT
   *   DO UPDATE is scoped to the same organization_id.
   *
   * The secret material in the response is intentionally included so callers
   * that manage secrets (e.g., the admin service) can confirm what was stored.
   * List endpoints must strip the secret before returning to API consumers.
   */
  async upsert(data: {
    organizationId: string
    url: string
    secret: string
    events: string[]
    fieldPolicy?: FieldPolicy
  }): Promise<WebhookSubscriber> {
    const fieldPolicyJson = JSON.stringify(data.fieldPolicy ?? DEFAULT_FIELD_POLICY)
    const [row] = await this.db
      .raw<{ rows: SubscriberRow[] }>(
        `
        INSERT INTO webhook_subscribers (organization_id, url, secret, events, active, field_policy)
        VALUES (:organizationId, :url, :secret, :events::jsonb, true, :fieldPolicy::jsonb)
        ON CONFLICT (organization_id, url)
        DO UPDATE SET
          secret       = EXCLUDED.secret,
          events       = EXCLUDED.events,
          field_policy = EXCLUDED.field_policy,
          active       = true,
          updated_at   = now()
        WHERE webhook_subscribers.organization_id = :organizationId
        RETURNING *
        `,
        {
          organizationId: data.organizationId,
          url: data.url,
          secret: encryptField(data.secret),
          events: JSON.stringify(data.events),
          fieldPolicy: fieldPolicyJson,
        },
      )
      .then((result) => result.rows)

    return toSubscriber(row)
  }

  /**
   * Updates the field policy for a subscriber.
   * Returns null if the subscriber does not exist or belongs to a different org.
   */
  async updateFieldPolicy(
    id: string,
    organizationId: string,
    fieldPolicy: FieldPolicy,
  ): Promise<WebhookSubscriber | null> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ id, organization_id: organizationId })
      .update({
        field_policy: JSON.stringify(fieldPolicy),
        updated_at: this.db.fn.now(),
      })
      .returning('*')

    if (rows.length === 0) return null
    return toSubscriber(rows[0])
  }

  /**
   * Rotates the signing secret for a subscriber.
   *
   * The current secret is moved to `previous_secret` and `rotated_at` is
   * stamped to now so the delivery layer can honour the grace window.
   * The new secret begins signing immediately; the previous secret remains
   * valid for verification until the grace window closes.
   *
   * Returns `null` if the subscriber does not exist or belongs to a different
   * organization (cross-org rotation is rejected silently to avoid enumeration).
   */
  async rotateSecret(
    id: string,
    organizationId: string,
    newSecret: string,
  ): Promise<WebhookSubscriber | null> {
    const rows = await this.db<SubscriberRow>('webhook_subscribers')
      .where({ id, organization_id: organizationId })
      .update({
        // The current (already-encrypted) secret column is copied verbatim into
        // previous_secret — it stays ciphertext, no re-encryption needed.
        previous_secret: this.db.raw('secret'),
        secret: encryptField(newSecret),
        rotated_at: this.db.fn.now(),
        updated_at: this.db.fn.now(),
      })
      .returning('*')

    if (rows.length === 0) return null
    return toSubscriber(rows[0])
  }

  async deactivate(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers')
      .where({ id })
      .update({ active: false, updated_at: this.db.fn.now() })
    return count > 0
  }

  async remove(id: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers').where({ id }).del()
    return count > 0
  }

  /**
   * Org-scoped removal. Deletes only when the row both exists AND belongs to
   * the given organization, so a caller who is authorized for org A can never
   * delete a subscriber owned by org B (enforced in SQL, not inferred from a
   * client-supplied id + membership the caller happens to hold).
   */
  async removeForOrg(id: string, organizationId: string): Promise<boolean> {
    const count = await this.db('webhook_subscribers')
      .where({ id, organization_id: organizationId })
      .del()
    return count > 0
  }

  async upsertBreakerState(
    subscriberId: string,
    data: {
      state: BreakerStateValue
      failureCount?: number
      lastFailureAt?: string | null
      trippedAt?: string | null
      halfOpenAt?: string | null
    },
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      state: data.state,
      updated_at: this.db.fn.now(),
    }
    if (data.failureCount !== undefined) payload.failure_count = data.failureCount
    if (data.lastFailureAt !== undefined) payload.last_failure_at = data.lastFailureAt
    if (data.trippedAt !== undefined) payload.tripped_at = data.trippedAt
    if (data.halfOpenAt !== undefined) payload.half_open_at = data.halfOpenAt

    await this.db('webhook_breaker_states')
      .insert({
        subscriber_id: subscriberId,
        ...payload,
      })
      .onConflict('subscriber_id')
      .merge()
  }

  async getBreakerState(subscriberId: string): Promise<BreakerState | null> {
    const row = await this.db<BreakerRow>('webhook_breaker_states')
      .where({ subscriber_id: subscriberId })
      .first()
    return row ? toBreakerState(row) : null
  }

  async tryTransitionToHalfOpen(
    subscriberId: string,
    now: Date,
  ): Promise<boolean> {
    const affected = await this.db('webhook_breaker_states')
      .where({
        subscriber_id: subscriberId,
        state: 'OPEN',
      })
      .update({
        state: 'HALF_OPEN',
        half_open_at: now,
        updated_at: this.db.fn.now(),
      })
    return affected > 0
  }

  async getAllBreakerStates(): Promise<BreakerState[]> {
    const rows = await this.db<BreakerRow>('webhook_breaker_states').select('*')
    return rows.map(toBreakerState)
  }

  async removeBreakerState(subscriberId: string): Promise<boolean> {
    const count = await this.db('webhook_breaker_states')
      .where({ subscriber_id: subscriberId })
      .del()
    return count > 0
  }

  /**
   * Returns aggregated delivery analytics for a subscriber over [windowStart, windowEnd).
   * Uses PostgreSQL percentile_cont for accurate latency percentiles.
   * All queries are bounded by the indexed (subscriber_id, attempted_at/failed_at) columns.
   */
  async getDeliveryStats(
    subscriberId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<DeliveryStats> {
    const [agg] = await this.db.raw<{ rows: Array<{
      attempt_count: string
      success_count: string
      p50: number | null
      p95: number | null
    }> }>(
      `
      SELECT
        COUNT(*)::bigint AS attempt_count,
        SUM(CASE WHEN success THEN 1 ELSE 0 END)::bigint AS success_count,
        PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95
      FROM webhook_delivery_attempts
      WHERE subscriber_id = :subscriberId
        AND attempted_at >= :windowStart
        AND attempted_at < :windowEnd
      `,
      { subscriberId, windowStart, windowEnd },
    ).then((r) => r.rows)

    const attemptCount = Number(agg.attempt_count ?? 0)
    const successCount = Number(agg.success_count ?? 0)
    const failureCount = attemptCount - successCount

    const dlRow = await this.db('webhook_dead_letters')
      .where('subscriber_id', subscriberId)
      .where('failed_at', '>=', windowStart)
      .where('failed_at', '<', windowEnd)
      .orderBy('failed_at', 'desc')
      .select('last_error')
      .first()

    const breakerRow = await this.db('webhook_breaker_states')
      .where({ subscriber_id: subscriberId })
      .select('state')
      .first()

    return {
      attempt_count: attemptCount,
      success_count: successCount,
      failure_count: failureCount,
      success_rate: attemptCount === 0 ? 0 : Math.round((successCount / attemptCount) * 1000) / 1000,
      p50_latency_ms: agg.p50 != null ? Math.round(agg.p50) : null,
      p95_latency_ms: agg.p95 != null ? Math.round(agg.p95) : null,
      last_failure_reason: dlRow?.last_error ?? null,
      breaker_state: (breakerRow?.state as BreakerStateValue) ?? null,
    }
  }
}
