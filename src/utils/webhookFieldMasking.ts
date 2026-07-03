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
export function parseFieldPolicy(value: unknown): FieldPolicy {
  if (isValidFieldPolicy(value)) {
    return value
  }
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
 * Supports exact matches and prefix matching with wildcards.
 * Example: 'vault.*' matches 'vault.id', 'vault.name', etc.
 */
function fieldMatchesPattern(field: string, pattern: string): boolean {
  if (pattern.endsWith('.*')) {
    const prefix = pattern.slice(0, -2)
    return field === prefix || field.startsWith(prefix + '.')
  }
  return field === pattern
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
 */
function collectFieldPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = []

  if (obj === null || obj === undefined || typeof obj !== 'object') {
    return paths
  }

  if (Array.isArray(obj)) {
    // For arrays, we include the array field but don't recurse into indexed items for filtering
    return paths
  }

  for (const key of Object.keys(obj)) {
    const fullPath = prefix ? `${prefix}.${key}` : key
    paths.push(fullPath)

    const value = (obj as Record<string, unknown>)[key]
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      paths.push(...collectFieldPaths(value, fullPath))
    }
  }

  return paths
}

/**
 * Filters an object based on allowlist/denylist field policy.
 */
function filterByFieldPolicy(payload: Record<string, unknown>, policy: FieldPolicy): Record<string, unknown> {
  if (policy.mode === 'default') {
    return payload
  }

  const allPaths = collectFieldPaths(payload)
  const result: Record<string, unknown> = {}

  for (const path of allPaths) {
    if (shouldIncludeField(path, policy)) {
      const value = getNestedValue(payload, path)
      // Only set leaf values (non-object or arrays)
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        setNestedValue(result, path, value)
      }
    }
  }

  return result
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
