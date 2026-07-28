import { maskPii, isPrivacySensitiveField, sanitizePrivacyPayload } from './privacy.js'

export type FieldPolicyMode = 'default' | 'allowlist' | 'denylist'

export interface FieldPolicy {
  mode: FieldPolicyMode
  fields: string[]
  stripPii: boolean
}

export const DEFAULT_FIELD_POLICY: FieldPolicy = {
  mode: 'default',
  fields: [],
  stripPii: true,
}

/**
 * Validates a FieldPolicy object structure.
 */
export function isValidFieldPolicy(value: unknown): value is FieldPolicy {
  if (!value || typeof value !== 'object') {
    return false
  }

  const policy = value as Record<string, unknown>

  if (!['default', 'allowlist', 'denylist'].includes(policy.mode as string)) {
    return false
  }

  if (!Array.isArray(policy.fields)) {
    return false
  }

  if (!policy.fields.every((f) => typeof f === 'string')) {
    return false
  }

  if (typeof policy.stripPii !== 'boolean') {
    return false
  }

  return true
}

/**
 * Parses a FieldPolicy from JSONB, returning defaults for invalid/null input.
 */
export function parseFieldPolicy(value: unknown, subscriberId?: string): FieldPolicy {
  if (isValidFieldPolicy(value)) {
    return value
  }
  console.warn(`Invalid stored FieldPolicy for subscriber ${subscriberId || 'unknown'}: substituting default policy.`, { invalidValue: value })
  return { ...DEFAULT_FIELD_POLICY }
}

/**
 * Gets a nested value from an object using dot notation.
 * Example: getNestedValue({ vault: { id: '123' } }, 'vault.id') => '123'
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined
    }
    current = (current as Record<string, unknown>)[part]
  }

  return current
}

/**
 * Sets a nested value in an object using dot notation.
 * Creates intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let current = obj

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]
    if (!(part in current) || typeof current[part] !== 'object' || current[part] === null) {
      current[part] = {}
    }
    current = current[part] as Record<string, unknown>
  }

  current[parts[parts.length - 1]] = value
}

/**
 * Checks if a field path matches an allowlist/denylist pattern.
 * Supports exact matches and two wildcard conventions:
 *  - Trailing '.*' (e.g. 'vault.*') matches the prefix itself as well as any
 *    single field beneath it. Preserved from the original behaviour.
 *  - Per-segment '*' or numeric indices (e.g. 'milestones.*.evidenceUrl' or
 *    'milestones.0.evidenceUrl') match individual indexed array elements so
 *    that allowlist/denylist policies can target sub-fields of array items.
 *    Patterns split into the same number of segments as the field path.
 */
function fieldMatchesPattern(field: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return field === prefix || field.startsWith(prefix + '.')
  }

  const fieldParts = field.split('.')
  const patternParts = pattern.split('.')
  if (patternParts.length !== fieldParts.length) {
    return false
  }
  return patternParts.every((part, i) => {
    // '*' is a wildcard segment that matches any path segment (e.g. for
    // indexed arrays: 'milestones.*.evidenceUrl' matches every element's
    // evidenceUrl field). Numeric segment values are matched literally so
    // that 'milestones.0.evidenceUrl' only matches the first element's
    // evidenceUrl field, not every indexed element's.
    if (part === '*') return true
    return part === fieldParts[i]
  })
}

/**
 * Checks if a field should be included based on the policy.
 */
function shouldIncludeField(field: string, policy: FieldPolicy): boolean {
  switch (policy.mode) {
    case 'allowlist':
      return policy.fields.some((pattern) => fieldMatchesPattern(field, pattern))
    case 'denylist':
      return !policy.fields.some((pattern) => fieldMatchesPattern(field, pattern))
    case 'default':
    default:
      return true
  }
}

/**
 * Recursively collects all field paths from an object.
 *
 * Array-valued fields are descended into with an *indexed* path convention:
 * `milestones` becomes `milestones`, `milestones.0`, `milestones.0.title`,
 * `milestones.1`, `milestones.1.title`, ... Each indexed element's leaf
 * properties are emitted so that allowlist/denylist patterns using
 * `milestones.*.evidenceUrl` (or the equivalent indexed pattern) can match
 * the array's sub-fields.
 */
function collectFieldPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = []

  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return paths
  }

  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      const itemPath = prefix ? `${prefix}.${index}` : String(index)
      paths.push(itemPath)

      if (item !== null && typeof item === 'object') {
        paths.push(...collectFieldPaths(item, itemPath))
      }
    })
    return paths
  }

  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    paths.push(fullPath)

    const value = (obj as Record<string, unknown>)[key]
    if (value !== null && typeof value === 'object') {
      paths.push(...collectFieldPaths(value, fullPath))
    }
  }

  return paths
}

/**
 * Recursively walks a value, applying the field policy at each path level.
 *
 * - DENYLIST mode gates every level: if a deny pattern matches the current
 *   path (including trailing-wildcard matches like `milestones.*`), the
 *   entire subtree is excluded. This is what stops `milestones` from being
 *   pre-populated with the original array and then having sub-field denies
 *   "shadowed" by the over-broad leaf-set behaviour in the original code.
 *
 * - ALLOWLIST mode only gates on primitive leaves. Listing `nested.allowed`
 *   must still flow through the unlisted `nested` parent to reach the leaf,
 *   so the parent itself is not gated in allowlist mode.
 *
 * Arrays descend with an indexed path convention (`a.0.b`, `a.1.b`, …) and
 * are reconstructed as real arrays with placeholders so consumers see the
 * same index layout and array length as the input — critical for downstream
 * signature verification and JSON shape expectations in webhook delivery.
 */
function applyPolicyToChild(value: unknown, path: string, policy: FieldPolicy): unknown {
  if (policy.mode === 'denylist' && path !== '' && !shouldIncludeField(path, policy)) {
    return undefined
  }

  if (Array.isArray(value)) {
    const arr: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      const idxPath = `${path}.${i}`
      const el = value[i]
      const sub = applyPolicyToChild(el, idxPath, policy)
      if (sub === undefined) {
        // Preserve the array length and shape so downstream consumers see
        // the same indexing they sent on the wire.
        if (Array.isArray(el)) arr.push([])
        else if (el !== null && typeof el === 'object') arr.push({})
        else arr.push(undefined)
      } else {
        arr.push(sub)
      }
    }
    return arr
  }

  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(obj)) {
      const childPath = path ? `${path}.${key}` : key
      const sub = applyPolicyToChild(obj[key], childPath, policy)
      if (sub === undefined) continue
      // Drop empty intermediate objects so we don't emit `{ a: {} }`.
      if (typeof sub === 'object' && sub !== null && !Array.isArray(sub) && Object.keys(sub).length === 0) continue
      out[key] = sub
    }
    return out
  }

  // Primitive. Allowlist gates by exact path here.
  if (policy.mode === 'allowlist' && path !== '' && !shouldIncludeField(path, policy)) {
    return undefined
  }
  return value
}

/**
 * Filters an object based on allowlist/denylist field policy.
 *
 * Implementation delegates to {@link applyPolicyToChild} which descends into
 * arrays with indexed paths so that wildcard / numeric patterns targeting
 * sub-fields of array items actually strip those sub-fields rather than
 * letting the entire unfiltered array pass through.
 */
function filterByFieldPolicy(payload: Record<string, unknown>, policy: FieldPolicy): Record<string, unknown> {
  if (policy.mode === 'default') {
    return payload
  }

  const result = applyPolicyToChild(payload, '', policy)
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    return result as Record<string, unknown>
  }
  return {}
}

/**
 * Masks PII fields in the payload using deterministic hashing.
 */
function maskPiiFields(payload: Record<string, unknown>): Record<string, unknown> {
  return sanitizePrivacyPayload(payload) as Record<string, unknown>
}

/**
 * Applies field masking policy to a webhook payload.
 * This should be called BEFORE signing the payload.
 *
 * @param payload - The original webhook payload
 * @param policy - The field policy to apply
 * @returns The masked/filtered payload
 */
export function applyFieldMasking(
  payload: Record<string, unknown>,
  policy: FieldPolicy = DEFAULT_FIELD_POLICY
): Record<string, unknown> {
  // First apply allowlist/denylist filtering
  let result = filterByFieldPolicy(payload, policy)

  // Then apply PII stripping if enabled
  if (policy.stripPii) {
    result = maskPiiFields(result)
  }

  return result
}

/**
 * Creates a human-readable description of a field policy for documentation.
 */
export function describeFieldPolicy(policy: FieldPolicy): string {
  const parts: string[] = []

  switch (policy.mode) {
    case 'allowlist':
      parts.push(`Allowlist: ${policy.fields.length > 0 ? policy.fields.join(', ') : '(none)'}`)
      break
    case 'denylist':
      parts.push(`Denylist: ${policy.fields.length > 0 ? policy.fields.join(', ') : '(none)'}`)
      break
    case 'default':
      parts.push('Default policy')
      break
  }

  parts.push(`PII stripping: ${policy.stripPii ? 'enabled' : 'disabled'}`)

  return parts.join('; ')
}
