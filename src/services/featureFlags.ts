import { createHash } from 'node:crypto'
import { db } from '../db/knex.js'
import { getOrSet, invalidatePrefix, getCacheStats as getSharedCacheStats } from '../lib/cache.js'

/**
 * Feature flag names that can be toggled at runtime
 */
export enum FeatureFlag {
  ENTERPRISE_ANALYTICS = 'ENTERPRISE_ANALYTICS',
  MULTI_VERIFIER_ENABLED = 'MULTI_VERIFIER_ENABLED',
  ORGANIZATION_QUOTAS = 'ORGANIZATION_QUOTAS',
  ADVANCED_ANALYTICS = 'ADVANCED_ANALYTICS',
}

/**
 * Resolved flag values are cached in the shared (Redis-backed, or in-process
 * fallback when REDIS_URL isn't set) cache from ../lib/cache.js, so a
 * setFlag() on one instance is visible to every instance, not just the one
 * that wrote it.
 */
const FLAG_CACHE_TTL_SECONDS = 5 * 60 // 5 minutes

export type FeatureFlagContext = Record<string, string | number | boolean | null | undefined>

export interface FeatureFlagRule {
  attribute: string
  operator?: 'eq' | 'neq' | 'in' | 'not_in'
  value?: string | number | boolean | null
  values?: Array<string | number | boolean | null>
  enabled?: boolean
}

interface FeatureFlagRow {
  name: string
  org_id: string | null
  enabled: boolean
  rollout_percentage?: number | string | null
  rules?: string | FeatureFlagRule[] | null
}

/**
 * Generate cache key from flag name and organization ID
 */
function getCacheKey(name: string, orgId: string | null, context?: FeatureFlagContext): string {
  const contextKey = context
    ? Object.keys(context)
        .sort()
        .map((key) => `${key}=${String(context[key])}`)
        .join('&')
    : ''
  return `feature_flag:${name}:${orgId || 'global'}:${contextKey}`
}

function coerceBoolean(value: unknown): boolean {
  return value === true || value === 1 || value === '1'
}

function parseRules(value: FeatureFlagRow['rules']): FeatureFlagRule[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value
  }

  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function getRolloutPercentage(value: FeatureFlagRow['rollout_percentage']): number | null {
  if (value === null || value === undefined) {
    return null
  }

  const percentage = Number(value)
  if (!Number.isFinite(percentage)) {
    return null
  }

  return Math.min(100, Math.max(0, percentage))
}

export function getFeatureFlagBucket(name: string, orgId: string): number {
  const digest = createHash('sha256').update(`${name}:${orgId}`).digest()
  const bucket = digest.readUInt32BE(0) / 0x100000000
  return Math.floor(bucket * 100)
}

export function matchesFeatureFlagRule(
  rule: FeatureFlagRule,
  context: FeatureFlagContext = {},
): boolean {
  const actual = context[rule.attribute]
  const operator = rule.operator ?? 'eq'
  const values = rule.values ?? (Object.prototype.hasOwnProperty.call(rule, 'value') ? [rule.value] : [])

  switch (operator) {
    case 'eq':
      return actual === rule.value
    case 'neq':
      return actual !== rule.value
    case 'in':
      return values.includes(actual as any)
    case 'not_in':
      return !values.includes(actual as any)
    default:
      return false
  }
}

function evaluateTargetedFlag(
  row: FeatureFlagRow | undefined,
  name: string,
  orgId: string | null,
  context: FeatureFlagContext = {},
): boolean {
  if (!row) {
    return false
  }

  for (const rule of parseRules(row.rules)) {
    if (matchesFeatureFlagRule(rule, context)) {
      return rule.enabled ?? true
    }
  }

  const rolloutPercentage = getRolloutPercentage(row.rollout_percentage)
  if (orgId && rolloutPercentage !== null) {
    return getFeatureFlagBucket(name, orgId) < rolloutPercentage
  }

  return coerceBoolean(row.enabled)
}

/**
 * Get feature flag value for an organization with fallback to global setting
 *
 * Precedence:
 * 1. Organization-specific row is an explicit allow/deny override.
 * 2. Global attribute rules, in stored order, override percentage rollout.
 * 3. Global rollout_percentage uses a stable hash of (flagKey, orgId).
 * 4. Global enabled is the fallback default.
 *
 * Results are cached in the shared cache (Redis when configured) with a
 * 5-minute TTL, so writes from setFlag() are visible across instances.
 *
 * @param name - Feature flag name (from FeatureFlag enum)
 * @param orgId - Organization ID, or null for global lookup
 * @returns Promise<boolean> - Whether flag is enabled
 * @example
 *   // Check if enterprise analytics is enabled for org-123
 *   const enabled = await getFlag(FeatureFlag.ENTERPRISE_ANALYTICS, 'org-123')
 *
 *   // Check global default for a flag
 *   const globalEnabled = await getFlag(FeatureFlag.MULTI_VERIFIER_ENABLED, null)
 */
export async function getFlag(
  name: string,
  orgId: string | null,
  context: FeatureFlagContext = {},
): Promise<boolean> {
  if (orgId) {
    const cacheKey = getCacheKey(name, orgId, context)
    const orgVal = await getOrSet<boolean | null>(cacheKey, FLAG_CACHE_TTL_SECONDS, async () => {
      try {
        const row = await db('feature_flags').where({ name, org_id: orgId }).first() as FeatureFlagRow | undefined
        return row ? coerceBoolean(row.enabled) : null
      } catch (error) {
        console.error(`Error fetching org-specific flag ${name} for org ${orgId}:`, error)
        return null
      }
    })
    if (orgVal !== null) return orgVal
  }

  const effectiveOrgId = orgId ?? 'global'
  const globalCacheKey = getCacheKey(name, orgId, orgId ? context : undefined)
  return getOrSet<boolean>(globalCacheKey, FLAG_CACHE_TTL_SECONDS, async () => {
    if (orgId) {
      try {
        const row = await db('feature_flags').where({ name, org_id: orgId }).first() as FeatureFlagRow | undefined
        if (row) return coerceBoolean(row.enabled)
      } catch (error) {
        console.error(`Error fetching org-specific flag ${name} for ${orgId}:`, error)
      }
    }
    try {
      const globalRow = await db('feature_flags').where({ name, org_id: null }).first() as FeatureFlagRow | undefined
      return evaluateTargetedFlag(globalRow, name, orgId, context)
    } catch (error) {
      console.error(`Error fetching global flag ${name}:`, error)
      return false
    }
  })
}

/**
 * Set feature flag value for an organization and invalidate cache.
 */
export async function setFlag(
  name: string,
  orgId: string | null,
  enabled: boolean,
): Promise<boolean> {
  try {
    const updated = await db('feature_flags')
      .where({ name, org_id: orgId })
      .update({ enabled, updated_at: db.fn.now() })

    if (updated === 0) {
      await db('feature_flags').insert({
        name,
        org_id: orgId,
        enabled,
        updated_at: db.fn.now(),
      })
    }

    // Invalidate every cached variant of this flag (org-specific and
    // context-based) in the shared cache, so every instance picks up the
    // new value on its next read rather than serving a stale local copy.
    await invalidatePrefix(`feature_flag:${name}:`)

    return enabled
  } catch (error) {
    console.error(`Error setting flag ${name} for org ${orgId}:`, error)
    throw error
  }
}

/**
 * Get all feature flags for an organization (bypasses cache for bulk read).
 */
export async function getAllFlags(orgId: string | null): Promise<Record<string, boolean>> {
  const flags: Record<string, boolean> = {}
  try {
    const globalRows = await db('feature_flags').where({ org_id: null })
    for (const row of globalRows) {
      flags[row.name] = row.enabled
    }

    if (orgId) {
      const orgRows = await db('feature_flags').where({ org_id: orgId })
      for (const row of orgRows) {
        flags[row.name] = row.enabled
      }
    }
    return flags
  } catch (error) {
    console.error(`Error fetching all flags for org ${orgId}:`, error)
    return {}
  }
}

/**
 * Clear all feature flag cache entries.
 */
export async function clearCache(): Promise<void> {
  await invalidatePrefix('feature_flag:')
}

/**
 * Get cache statistics for monitoring/debugging.
 */
export function getCacheStats(): { size: number; maxSize: number } {
  return getSharedCacheStats()
}

/**
 * Type guard for FeatureFlag enum.
 */
export function isValidFeatureFlag(value: string): value is FeatureFlag {
  return Object.values(FeatureFlag).includes(value as FeatureFlag)
}
