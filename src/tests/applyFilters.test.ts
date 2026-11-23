/**
 * Unit tests for applyFilters (src/utils/pagination.ts)
 *
 * Focuses on the exactMatchFields contract:
 *   - Fields listed in exactMatchFields use strict String equality.
 *   - Fields NOT listed use case-insensitive substring matching.
 *   - Array-valued filters always use exact inclusion regardless of exactMatchFields.
 *   - Backward-compatible: omitting the third argument keeps the original
 *     substring-only behaviour for every field.
 */

import { applyFilters } from '../utils/pagination.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Vault = {
  id: string
  status: string
  creator: string
  amount: number
}

const VAULTS: Vault[] = [
  { id: '1', status: 'active',    creator: 'Alice',   amount: 100 },
  { id: '2', status: 'cancelled', creator: 'Charlie', amount: 200 },
  { id: '3', status: 'failed',    creator: 'Bob',     amount: 300 },
  { id: '4', status: 'completed', creator: 'David',   amount: 400 },
  { id: '5', status: 'active',    creator: 'carol',   amount: 500 },
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ids(vaults: Vault[]): string[] {
  return vaults.map((v) => v.id)
}

// ---------------------------------------------------------------------------
// 1. Exact-match fields (third param supplied)
// ---------------------------------------------------------------------------

describe('applyFilters – exact match for enum fields', () => {
  it('returns only vaults whose status equals the filter value exactly', () => {
    const result = applyFilters(VAULTS, { status: 'active' }, ['status'])
    expect(ids(result)).toEqual(['1', '5'])
  })

  it('returns only the cancelled vault — does not bleed into active/failed which contain "a"', () => {
    const result = applyFilters(VAULTS, { status: 'cancelled' }, ['status'])
    expect(ids(result)).toEqual(['2'])
  })

  it('returns only the failed vault', () => {
    const result = applyFilters(VAULTS, { status: 'failed' }, ['status'])
    expect(ids(result)).toEqual(['3'])
  })

  it('returns empty when the status value does not match any vault exactly', () => {
    // "a" would substring-match active/cancelled/failed — exact match must return []
    const result = applyFilters(VAULTS, { status: 'a' }, ['status'])
    expect(result).toHaveLength(0)
  })

  it('is case-sensitive for exact-match fields — "Active" does not match "active"', () => {
    const result = applyFilters(VAULTS, { status: 'Active' }, ['status'])
    expect(result).toHaveLength(0)
  })

  it('returns nothing for a partial prefix like "act"', () => {
    const result = applyFilters(VAULTS, { status: 'act' }, ['status'])
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 2. Substring match for non-exact fields (default behaviour preserved)
// ---------------------------------------------------------------------------

describe('applyFilters – substring match for free-text fields', () => {
  it('matches creator by substring, case-insensitively', () => {
    // "ali" should match "Alice"
    const result = applyFilters(VAULTS, { creator: 'ali' }, ['status'])
    expect(ids(result)).toEqual(['1'])
  })

  it('matches creator case-insensitively across mixed-case data', () => {
    // "carol" should match both "Carol" (id 5) if present and "charlie" (id 2 contains no "carol")
    const result = applyFilters(VAULTS, { creator: 'carol' }, ['status'])
    // Only vault 5 has creator 'carol' (exact), and vault 2 has 'Charlie' which does not contain 'carol'
    expect(ids(result)).toEqual(['5'])
  })

  it('matches creator with a partial match that spans multiple items', () => {
    // "a" appears in Alice, Charlie, David, carol
    const result = applyFilters(VAULTS, { creator: 'a' }, ['status'])
    expect(ids(result)).toEqual(['1', '2', '4', '5'])
  })
})

// ---------------------------------------------------------------------------
// 3. Backward-compatibility: no exactMatchFields → substring for all fields
// ---------------------------------------------------------------------------

describe('applyFilters – backward-compatible (no exactMatchFields)', () => {
  it('matches status by substring when exactMatchFields is omitted', () => {
    // The old behaviour: "act" matches "active"
    const result = applyFilters(VAULTS, { status: 'act' })
    expect(ids(result)).toEqual(['1', '5'])
  })

  it('matches status by substring when exactMatchFields is an empty array', () => {
    const result = applyFilters(VAULTS, { status: 'fail' }, [])
    expect(ids(result)).toEqual(['3'])
  })

  it('"a" matches all vaults whose status contains "a" (active, cancelled, failed)', () => {
    const result = applyFilters(VAULTS, { status: 'a' })
    // active (1,5), cancelled (2), failed (3) all contain 'a'
    expect(ids(result)).toEqual(['1', '2', '3', '5'])
  })
})

// ---------------------------------------------------------------------------
// 4. Combined filters: exact-match field + substring field together
// ---------------------------------------------------------------------------

describe('applyFilters – combined exact + substring filters', () => {
  it('narrows by exact status AND substring creator simultaneously', () => {
    // status=active (exact) AND creator contains "ali" → only vault 1
    const result = applyFilters(VAULTS, { status: 'active', creator: 'ali' }, ['status'])
    expect(ids(result)).toEqual(['1'])
  })

  it('returns empty when status exact-matches but creator does not substring-match', () => {
    const result = applyFilters(VAULTS, { status: 'active', creator: 'xyz' }, ['status'])
    expect(result).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// 5. Array-valued filters: always exact inclusion, unaffected by exactMatchFields
// ---------------------------------------------------------------------------

describe('applyFilters – array-valued filters', () => {
  it('includes items whose field value is in the provided array', () => {
    const result = applyFilters(VAULTS, { status: ['active', 'failed'] }, ['status'])
    expect(ids(result)).toEqual(['1', '3', '5'])
  })

  it('uses exact inclusion even when the field is NOT in exactMatchFields', () => {
    // Without exactMatchFields for status, array filters should still do inclusion
    const result = applyFilters(VAULTS, { status: ['active', 'failed'] })
    expect(ids(result)).toEqual(['1', '3', '5'])
  })
})

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe('applyFilters – edge cases', () => {
  it('returns all items when filters is an empty object', () => {
    const result = applyFilters(VAULTS, {}, ['status'])
    expect(result).toHaveLength(VAULTS.length)
  })

  it('returns empty array for an empty input array', () => {
    const result = applyFilters([], { status: 'active' }, ['status'])
    expect(result).toHaveLength(0)
  })

  it('returns false for an item that has no matching key (itemValue === undefined)', () => {
    const items = [{ id: '1', creator: 'Alice' } as any]
    const result = applyFilters(items, { status: 'active' }, ['status'])
    expect(result).toHaveLength(0)
  })

  it('skips a filter entry whose value is undefined', () => {
    const result = applyFilters(VAULTS, { status: undefined as any }, ['status'])
    expect(result).toHaveLength(VAULTS.length)
  })
})
