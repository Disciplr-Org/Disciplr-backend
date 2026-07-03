import { orgReadRateLimiter, orgWriteRateLimiter } from '../middleware/rateLimiter.js'
import { Router, Request, Response } from 'express'
import { authenticate } from '../middleware/auth.js'
import { requireOrgAccess } from '../middleware/orgAuth.js'
import { queryParser } from '../middleware/queryParser.js'
import { applyFilters, applySort, paginateArray, encodeCursor, decodeCursor } from '../utils/pagination.js'
import { vaults } from './vaults.js'
import db from '../db/index.js'
import type { Knex } from 'knex'
import { createHash } from 'node:crypto'

export const orgVaultsRouter = Router()

// ─── Existing vault list ──────────────────────────────────────────────────────

orgVaultsRouter.get(
  '/:orgId/vaults',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter,
  queryParser({
    allowedSortFields: ['createdAt', 'amount', 'endTimestamp', 'status'],
    allowedFilterFields: ['status', 'creator'],
  }),
  (req: Request, res: Response) => {
    const { orgId } = req.params
    let result = vaults.filter((v) => v.orgId === orgId)

    if (req.filters) {
      result = applyFilters(result, req.filters)
    }

    if (req.sort) {
      result = applySort(result, req.sort)
    }

    const paginatedResult = paginateArray(result, req.pagination!)
    res.json(paginatedResult)
  },
)

// ─── Saved-search constants ───────────────────────────────────────────────────

export const MAX_SEARCHES_PER_ORG = 20
export const MIN_ALERT_FREQUENCY_MS = 3_600_000 // 1 hour

const VALID_STATUSES = new Set(['draft', 'active', 'completed', 'failed', 'cancelled'])
const VALID_SORT_FIELDS = new Set(['created_at', 'amount', 'end_date', 'status'])
const VALID_SORT_ORDERS = new Set(['asc', 'desc'])

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SavedSearchQueryDefinition {
  q?: string
  status?: string
  verifier?: string
  amount_min?: string
  amount_max?: string
  date_from?: string
  date_to?: string
  sort_by?: string
  sort_order?: string
  limit?: number
}

export interface OrgVaultSearch {
  id: string
  org_id: string
  name: string
  query_definition: SavedSearchQueryDefinition
  alerts_enabled: boolean
  alert_recipient: string | null
  alert_frequency_ms: number
  last_evaluated_at: string | null
  last_result_hash: string | null
  created_by: string
  created_at: string
  updated_at: string
}

// ─── Validation ───────────────────────────────────────────────────────────────

export interface QueryValidationResult {
  valid: boolean
  errors: string[]
  sanitized: SavedSearchQueryDefinition
}

export function validateAndSanitizeQueryDefinition(raw: unknown): QueryValidationResult {
  const errors: string[] = []
  const sanitized: SavedSearchQueryDefinition = {}

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, errors: ['query_definition must be an object'], sanitized }
  }

  const input = raw as Record<string, unknown>

  if (input.q !== undefined) {
    if (typeof input.q !== 'string') {
      errors.push('q must be a string')
    } else {
      sanitized.q = input.q.replace(/[^\w\s.\-]/g, '').substring(0, 200)
    }
  }

  if (input.status !== undefined) {
    if (typeof input.status !== 'string' || !VALID_STATUSES.has(input.status)) {
      errors.push(`status must be one of: ${[...VALID_STATUSES].join(', ')}`)
    } else {
      sanitized.status = input.status
    }
  }

  if (input.verifier !== undefined) {
    if (typeof input.verifier !== 'string') {
      errors.push('verifier must be a string')
    } else {
      sanitized.verifier = input.verifier.slice(0, 256)
    }
  }

  for (const field of ['amount_min', 'amount_max'] as const) {
    if (input[field] !== undefined) {
      const v = String(input[field])
      if (!/^\d+(\.\d+)?$/.test(v)) {
        errors.push(`${field} must be a non-negative numeric string`)
      } else {
        sanitized[field] = v
      }
    }
  }

  for (const field of ['date_from', 'date_to'] as const) {
    if (input[field] !== undefined) {
      if (typeof input[field] !== 'string' || isNaN(Date.parse(input[field] as string))) {
        errors.push(`${field} must be a valid ISO 8601 date string`)
      } else {
        sanitized[field] = input[field] as string
      }
    }
  }

  if (input.sort_by !== undefined) {
    if (typeof input.sort_by !== 'string' || !VALID_SORT_FIELDS.has(input.sort_by)) {
      errors.push(`sort_by must be one of: ${[...VALID_SORT_FIELDS].join(', ')}`)
    } else {
      sanitized.sort_by = input.sort_by
    }
  }

  if (input.sort_order !== undefined) {
    if (typeof input.sort_order !== 'string' || !VALID_SORT_ORDERS.has(input.sort_order)) {
      errors.push('sort_order must be "asc" or "desc"')
    } else {
      sanitized.sort_order = input.sort_order
    }
  }

  if (input.limit !== undefined) {
    const n = Number(input.limit)
    if (!Number.isInteger(n) || n < 1 || n > 100) {
      errors.push('limit must be an integer between 1 and 100')
    } else {
      sanitized.limit = n
    }
  }

  return { valid: errors.length === 0, errors, sanitized }
}

// ─── Shared evaluation helper (also used by the periodic job) ─────────────────

export async function runSavedSearch(
  orgId: string,
  queryDef: SavedSearchQueryDefinition,
): Promise<string[]> {
  const limit = Math.min(100, Math.max(1, queryDef.limit ?? 20))

  let query = db('vaults')
    .where('organization_id', orgId)
    .whereNull('deleted_at')
    .select('id')

  if (queryDef.q) {
    const q = queryDef.q
    const hasFtsColumn = await db('information_schema.columns')
      .where({ table_schema: 'public', table_name: 'vaults', column_name: 'search_vector' })
      .first()
      .then(Boolean)

    if (hasFtsColumn) {
      query = query.whereRaw(
        `search_vector @@ to_tsquery('simple', ?)`,
        [q.split(/\s+/).filter(Boolean).map((t) => `${t}:*`).join(' & ')],
      )
    } else {
      query = query.where((builder: Knex.QueryBuilder) => {
        builder.where('creator', 'ilike', `%${q}%`).orWhere('verifier', 'ilike', `%${q}%`)
      })
    }
  }

  if (queryDef.status) query = query.where('status', queryDef.status)
  if (queryDef.verifier) query = query.where('verifier', queryDef.verifier)
  if (queryDef.amount_min) query = query.where('amount', '>=', queryDef.amount_min)
  if (queryDef.amount_max) query = query.where('amount', '<=', queryDef.amount_max)
  if (queryDef.date_from) query = query.where('created_at', '>=', new Date(queryDef.date_from))
  if (queryDef.date_to) query = query.where('created_at', '<=', new Date(queryDef.date_to))

  const sortField = queryDef.sort_by ?? 'created_at'
  const sortOrder = (queryDef.sort_order ?? 'desc') as 'asc' | 'desc'
  query = query.orderBy(sortField, sortOrder).orderBy('id', 'desc')

  const rows = await query.limit(limit)
  return rows.map((r: { id: string }) => r.id)
}

export function hashResultSet(ids: string[]): string {
  return createHash('sha256').update(JSON.stringify(ids)).digest('hex')
}

// ─── POST /api/orgs/:orgId/vault-searches ─────────────────────────────────────

orgVaultsRouter.post(
  '/:orgId/vault-searches',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgWriteRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req.params
    const userId: string = (req.user as any)?.userId || (req.user as any)?.sub || ''

    const { name, query_definition, alerts_enabled, alert_recipient, alert_frequency_ms } = req.body

    if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
      res.status(400).json({ error: 'name must be a non-empty string (max 255 chars)' })
      return
    }

    const validation = validateAndSanitizeQueryDefinition(query_definition)
    if (!validation.valid) {
      res.status(400).json({ error: 'Invalid query_definition', details: validation.errors })
      return
    }

    const alertsOn = Boolean(alerts_enabled)

    if (alertsOn) {
      if (typeof alert_recipient !== 'string' || alert_recipient.trim().length === 0) {
        res.status(400).json({ error: 'alert_recipient is required when alerts_enabled is true' })
        return
      }

      const freqMs = alert_frequency_ms !== undefined ? Number(alert_frequency_ms) : MIN_ALERT_FREQUENCY_MS
      if (!Number.isInteger(freqMs) || freqMs < MIN_ALERT_FREQUENCY_MS) {
        res.status(400).json({
          error: `alert_frequency_ms must be an integer >= ${MIN_ALERT_FREQUENCY_MS} (1 hour)`,
        })
        return
      }
    }

    try {
      const countRow = await db('org_vault_searches')
        .where({ org_id: orgId })
        .count('id as n')
        .first()

      const currentCount = Number(countRow?.n ?? 0)
      if (currentCount >= MAX_SEARCHES_PER_ORG) {
        res.status(422).json({
          error: `Org has reached the maximum of ${MAX_SEARCHES_PER_ORG} saved searches`,
        })
        return
      }

      const [search] = await db('org_vault_searches')
        .insert({
          org_id: orgId,
          name: name.trim(),
          query_definition: JSON.stringify(validation.sanitized),
          alerts_enabled: alertsOn,
          alert_recipient: alertsOn ? (alert_recipient as string).trim() : null,
          alert_frequency_ms: alertsOn
            ? (alert_frequency_ms !== undefined ? Number(alert_frequency_ms) : MIN_ALERT_FREQUENCY_MS)
            : MIN_ALERT_FREQUENCY_MS,
          created_by: userId,
          created_at: new Date(),
          updated_at: new Date(),
        })
        .returning('*')

      res.status(201).json({ search })
    } catch (error) {
      console.error('Error creating saved search:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── GET /api/orgs/:orgId/vault-searches ──────────────────────────────────────

orgVaultsRouter.get(
  '/:orgId/vault-searches',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req.params

    try {
      const searches: OrgVaultSearch[] = await db('org_vault_searches')
        .where({ org_id: orgId })
        .orderBy('created_at', 'desc')

      res.json({ searches })
    } catch (error) {
      console.error('Error listing saved searches:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── GET /api/orgs/:orgId/vault-searches/:searchId ────────────────────────────

orgVaultsRouter.get(
  '/:orgId/vault-searches/:searchId',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { orgId, searchId } = req.params

    try {
      const search: OrgVaultSearch | undefined = await db('org_vault_searches')
        .where({ id: searchId, org_id: orgId })
        .first()

      if (!search) {
        res.status(404).json({ error: 'Saved search not found' })
        return
      }

      res.json({ search })
    } catch (error) {
      console.error('Error fetching saved search:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

// ─── DELETE /api/orgs/:orgId/vault-searches/:searchId ─────────────────────────

orgVaultsRouter.delete(
  '/:orgId/vault-searches/:searchId',
  authenticate,
  requireOrgAccess('owner', 'admin'),
  orgWriteRateLimiter,
  async (req: Request, res: Response): Promise<void> => {
    const { orgId, searchId } = req.params

    try {
      const deleted = await db('org_vault_searches')
        .where({ id: searchId, org_id: orgId })
        .delete()

      if (deleted === 0) {
        res.status(404).json({ error: 'Saved search not found' })
        return
      }

      res.status(204).end()
    } catch (error) {
      console.error('Error deleting saved search:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)

/**
 * GET /api/orgs/:orgId/vaults/search
 *
 * Org-scoped vault search with full-text matching and structured filters.
 * Results are cursor-paginated for stable, consistent paging.
 *
 * Query parameters:
 *   q            - Full-text search term (matches creator + verifier via tsvector/GIN index,
 *                  falls back to ILIKE when the DB has no tsvector column yet)
 *   status       - Exact status filter: draft | active | completed | failed | cancelled
 *   verifier     - Exact verifier address filter
 *   amount_min   - Minimum vault amount (inclusive)
 *   amount_max   - Maximum vault amount (inclusive)
 *   date_from    - Minimum created_at (ISO 8601 inclusive)
 *   date_to      - Maximum created_at (ISO 8601 inclusive)
 *   cursor       - Opaque pagination cursor from a previous response
 *   limit        - Page size (1–100, default 20)
 */
orgVaultsRouter.get(
  '/:orgId/vaults/search',
  authenticate,
  requireOrgAccess('owner', 'admin', 'member'),
  orgReadRateLimiter,
  queryParser({
    allowedSortFields: ['created_at', 'amount', 'end_date', 'status'],
    allowedFilterFields: ['status', 'verifier', 'amount_min', 'amount_max', 'date_from', 'date_to'],
  }),
  async (req: Request, res: Response): Promise<void> => {
    const { orgId } = req.params

    // ── Raw search term ─────────────────────────────────────────────────────
    // Strip to plain text — no special characters that could be meaningful
    // to tsvector/ILIKE beyond the literal token.
    const rawQ = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    // Sanitise: keep only alphanumeric, spaces, dots, hyphens, underscores
    const q = rawQ.replace(/[^\w\s.\-]/g, '').substring(0, 200)

    // ── Pagination ──────────────────────────────────────────────────────────
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '20'))))
    const rawCursor = typeof req.query.cursor === 'string' ? req.query.cursor : undefined

    try {
      // ── Base query — always scoped to the org and not soft-deleted ────────
      let query = db('vaults')
        .where('organization_id', orgId)
        .whereNull('deleted_at')

      // ── Full-text search ─────────────────────────────────────────────────
      if (q) {
        // Check whether the tsvector column exists (migration may not have run yet)
        const hasFtsColumn = await db('information_schema.columns')
          .where({
            table_schema: 'public',
            table_name: 'vaults',
            column_name: 'search_vector',
          })
          .first()
          .then(Boolean)

        if (hasFtsColumn) {
          // GIN index path — injection-safe: q is bound via knex parameterisation
          query = query.whereRaw(
            `search_vector @@ to_tsquery('simple', ?)`,
            [q.split(/\s+/).filter(Boolean).map(t => `${t}:*`).join(' & ')],
          )
        } else {
          // Fallback ILIKE path (slower, but safe until migration runs)
          query = query.where(function () {
            this.where('creator', 'ilike', `%${q}%`)
              .orWhere('verifier', 'ilike', `%${q}%`)
          })
        }
      }

      // ── Structured filters ───────────────────────────────────────────────
      const filters = req.filters ?? {}

      if (filters.status) {
        const status = Array.isArray(filters.status) ? filters.status[0] : filters.status
        query = query.where('status', status)
      }

      if (filters.verifier) {
        const verifier = Array.isArray(filters.verifier) ? filters.verifier[0] : filters.verifier
        query = query.where('verifier', verifier)
      }

      if (filters.amount_min) {
        const min = Array.isArray(filters.amount_min) ? filters.amount_min[0] : filters.amount_min
        query = query.where('amount', '>=', min)
      }

      if (filters.amount_max) {
        const max = Array.isArray(filters.amount_max) ? filters.amount_max[0] : filters.amount_max
        query = query.where('amount', '<=', max)
      }

      if (filters.date_from) {
        const from = Array.isArray(filters.date_from) ? filters.date_from[0] : filters.date_from
        query = query.where('created_at', '>=', new Date(from))
      }

      if (filters.date_to) {
        const to = Array.isArray(filters.date_to) ? filters.date_to[0] : filters.date_to
        query = query.where('created_at', '<=', new Date(to))
      }

      // ── Cursor pagination ────────────────────────────────────────────────
      // Stable sort: (created_at DESC, id DESC) — matches encodeCursor/decodeCursor contract
      if (rawCursor) {
        try {
          const { timestamp, id } = decodeCursor(rawCursor)
          query = query.where(function () {
            this.where('created_at', '<', timestamp)
              .orWhere(function () {
                this.where('created_at', '=', timestamp).andWhere('id', '<', id)
              })
          })
        } catch {
          res.status(400).json({ error: 'Invalid cursor' })
          return
        }
      }

      // Enforce stable ordering
      query = query.orderBy('created_at', 'desc').orderBy('id', 'desc')

      // Fetch limit + 1 to detect whether a next page exists
      const rows = await query.limit(limit + 1).select(
        'id',
        'creator',
        'verifier',
        'amount',
        'status',
        'organization_id',
        'start_date',
        'end_date',
        'created_at',
        'updated_at',
      )

      const hasMore = rows.length > limit
      const results = rows.slice(0, limit)

      let nextCursor: string | undefined
      if (hasMore && results.length > 0) {
        const last = results[results.length - 1]
        nextCursor = encodeCursor(new Date(last.created_at), last.id)
      }

      res.json({
        data: results,
        pagination: {
          limit,
          cursor: rawCursor,
          next_cursor: nextCursor,
          has_more: hasMore,
          count: results.length,
        },
      })
    } catch (error) {
      console.error('Error searching org vaults:', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  },
)
