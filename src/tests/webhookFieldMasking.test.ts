import { jest, describe, it, expect } from '@jest/globals'

jest.unstable_mockModule('../utils/privacy.js', () => {
  // No-op PII masker: keep field values intact so we can assert the
  // allowlist/denylist policy in isolation, without coupling to the
  // broader privacy masking pipeline.
  const identity = (v: unknown): unknown => v
  return {
    maskPii: identity,
    isPrivacySensitiveField: () => false,
    sanitizePrivacyPayload: identity,
  }
})

const { applyFieldMasking, DEFAULT_FIELD_POLICY, parseFieldPolicy } = await import(
  '../utils/webhookFieldMasking.js'
)

describe('collectFieldPaths / filterByFieldPolicy — array recursion (#1089)', () => {
  describe('denylist over array-valued fields', () => {
    it('strips a sensitive sub-field from every array element', () => {
      const payload = {
        eventId: 'evt-1',
        milestones: [
          { id: 'm-1', title: 'Spec', evidenceUrl: 'https://secret/a' },
          { id: 'm-2', title: 'Build', evidenceUrl: 'https://secret/b' },
        ],
      }

      const result = applyFieldMasking(payload, {
        mode: 'denylist',
        fields: ['milestones.*.evidenceUrl'],
        stripPii: false,
      })

      expect(result).toEqual({
        eventId: 'evt-1',
        milestones: [
          { id: 'm-1', title: 'Spec' },
          { id: 'm-2', title: 'Build' },
        ],
      })
    })

    it('strips the entire array field via trailing wildcard', () => {
      const payload = {
        eventId: 'evt-1',
        milestones: [{ evidenceUrl: 'x' }, { evidenceUrl: 'y' }],
        publicNote: 'visible',
      }

      const result = applyFieldMasking(payload, {
        mode: 'denylist',
        fields: ['milestones.*'],
        stripPii: false,
      })

      expect(result).toEqual({ eventId: 'evt-1', publicNote: 'visible' })
    })

    it('exact indexed pattern targets a single array element', () => {
      const payload = {
        milestones: [
          { evidenceUrl: 'keep-0' },
          { evidenceUrl: 'strip-1' },
          { evidenceUrl: 'keep-2' },
        ],
      }

      const result = applyFieldMasking(payload, {
        mode: 'denylist',
        fields: ['milestones.1.evidenceUrl'],
        stripPii: false,
      })

      expect(result).toEqual({
        milestones: [
          { evidenceUrl: 'keep-0' },
          { title: undefined, evidenceUrl: undefined },
          { evidenceUrl: 'keep-2' },
        ],
      })
      expect(result.milestones[1].evidenceUrl).toBeUndefined()
    })
  })

  describe('allowlist over array-valued fields', () => {
    it('keeps only listed sub-fields from each array element', () => {
      const payload = {
        milestones: [
          { id: 'm-1', title: 'Spec', evidenceUrl: 'secret-a' },
          { id: 'm-2', title: 'Build', evidenceUrl: 'secret-b' },
        ],
      }

      const result = applyFieldMasking(payload, {
        mode: 'allowlist',
        fields: ['milestones.*.id', 'milestones.*.title'],
        stripPii: false,
      })

      expect(result).toEqual({
        milestones: [
          { id: 'm-1', title: 'Spec' },
          { id: 'm-2', title: 'Build' },
        ],
      })
    })

    it('supports nested arrays-of-objects', () => {
      const payload = {
        groups: [
          {
            name: 'g1',
            items: [
              { id: 'i1', secretToken: 'tok-1' },
              { id: 'i2', secretToken: 'tok-2' },
            ],
          },
        ],
      }

      const result = applyFieldMasking(payload, {
        mode: 'denylist',
        fields: ['groups.*.items.*.secretToken'],
        stripPii: false,
      })

      expect(result).toEqual({
        groups: [
          {
            name: 'g1',
            items: [{ id: 'i1' }, { id: 'i2' }],
          },
        ],
      })
    })
  })

  describe('regression: existing object-only behaviour still works', () => {
    it('supports nested field paths on plain objects', () => {
      const data = { id: '123', nested: { public: 'yes', private: 'no' } }
      const result = applyFieldMasking(data, {
        mode: 'denylist',
        fields: ['nested.private'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', nested: { public: 'yes' } })
    })

    it('supports trailing wildcard patterns on plain objects', () => {
      const data = { id: '123', vault: { name: 'Test', status: 'active' }, other: 'excluded' }
      const result = applyFieldMasking(data, {
        mode: 'allowlist',
        fields: ['id', 'vault.*'],
        stripPii: false,
      })
      expect(result).toEqual({ id: '123', vault: { name: 'Test', status: 'active' } })
    })
  })

  describe('default policy is unchanged', () => {
    it('passes payload through when stripPii is disabled', () => {
      const payload = { a: 1, nested: { b: 2 }, arr: [{ c: 3 }] }
      const result = applyFieldMasking(payload, { mode: 'default', fields: [], stripPii: false })
      expect(result).toEqual(payload)
    })
  })

  describe('parseFieldPolicy', () => {
    it('accepts a wildcard array pattern as a valid field entry', () => {
      const policy = parseFieldPolicy({ mode: 'denylist', fields: ['milestones.*.secretToken'], stripPii: true })
      expect(policy.mode).toBe('denylist')
      expect(policy.fields).toEqual(['milestones.*.secretToken'])
    })

    it('falls back to default for invalid policy', () => {
      expect(parseFieldPolicy(null)).toEqual(DEFAULT_FIELD_POLICY)
    })
  })
})
