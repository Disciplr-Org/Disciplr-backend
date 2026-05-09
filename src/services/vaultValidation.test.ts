import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { 
  createVaultSchema, 
  VAULT_AMOUNT_MIN, 
  VAULT_AMOUNT_MAX,
  flattenZodErrors 
} from './vaultValidation.js'

describe('vaultValidation - createVaultSchema', () => {
  const validStellarAddress = `G${'A'.repeat(55)}`
  
  const validBasePayload = {
    amount: '1000',
    startDate: '2030-01-01T00:00:00.000Z',
    endDate: '2030-06-01T00:00:00.000Z',
    verifier: validStellarAddress,
    destinations: {
      success: validStellarAddress,
      failure: validStellarAddress,
    },
    milestones: [
      {
        title: 'Test Milestone',
        dueDate: '2030-02-01T00:00:00.000Z',
        amount: '500',
      },
    ],
  }

  describe('Required field validation', () => {
    test('rejects missing amount', () => {
      const payload = { ...validBasePayload }
      delete payload.amount
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'amount'))
    })

    test('rejects missing startDate', () => {
      const payload = { ...validBasePayload }
      delete payload.startDate
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'startDate'))
    })

    test('rejects missing endDate', () => {
      const payload = { ...validBasePayload }
      delete payload.endDate
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'endDate'))
    })

    test('rejects missing verifier', () => {
      const payload = { ...validBasePayload }
      delete payload.verifier
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'verifier'))
    })

    test('rejects missing destinations', () => {
      const payload = { ...validBasePayload }
      delete payload.destinations
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'destinations'))
    })

    test('rejects missing milestones', () => {
      const payload = { ...validBasePayload }
      delete payload.milestones
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => issue.path.join('.') === 'milestones'))
    })
  })

  describe('Amount validation', () => {
    test('accepts minimum valid amount', () => {
      const payload = { ...validBasePayload, amount: VAULT_AMOUNT_MIN.toString() }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('accepts maximum valid amount', () => {
      const payload = { ...validBasePayload, amount: VAULT_AMOUNT_MAX.toString() }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('rejects amount below minimum', () => {
      const payload = { ...validBasePayload, amount: (VAULT_AMOUNT_MIN - 1).toString() }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'amount' && 
        issue.message.includes('between')
      ))
    })

    test('rejects amount above maximum', () => {
      const payload = { ...validBasePayload, amount: (VAULT_AMOUNT_MAX + 1).toString() }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'amount' && 
        issue.message.includes('between')
      ))
    })

    test('rejects zero amount', () => {
      const payload = { ...validBasePayload, amount: '0' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects negative amount', () => {
      const payload = { ...validBasePayload, amount: '-100' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects non-numeric amount', () => {
      const payload = { ...validBasePayload, amount: 'abc' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects infinite amount', () => {
      const payload = { ...validBasePayload, amount: 'Infinity' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('accepts number input and converts to string', () => {
      const payload = { ...validBasePayload, amount: 1000 }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
      assert.equal(typeof result.data.amount, 'string')
      assert.equal(result.data.amount, '1000')
    })

    test('rejects NaN amount', () => {
      const payload = { ...validBasePayload, amount: NaN }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })
  })

  describe('Stellar address validation', () => {
    test('accepts valid Stellar G-address', () => {
      const payload = { 
        ...validBasePayload, 
        verifier: validStellarAddress,
        destinations: { success: validStellarAddress, failure: validStellarAddress }
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('rejects address starting with wrong prefix', () => {
      const invalidAddress = `A${'B'.repeat(55)}`
      const payload = { ...validBasePayload, verifier: invalidAddress }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'verifier' && 
        issue.message.includes('valid Stellar public key')
      ))
    })

    test('rejects address with wrong length', () => {
      const invalidAddress = `G${'A'.repeat(54)}`
      const payload = { ...validBasePayload, verifier: invalidAddress }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects address with invalid characters', () => {
      const invalidAddress = `G${'A'.repeat(50)}12345`
      const payload = { ...validBasePayload, verifier: invalidAddress }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects lowercase address', () => {
      const invalidAddress = `g${'a'.repeat(55)}`
      const payload = { ...validBasePayload, verifier: invalidAddress }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })
  })

  describe('Timestamp validation', () => {
    test('accepts valid ISO timestamps', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-01-01T00:00:00.000Z',
        endDate: '2030-06-01T00:00:00.000Z',
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('rejects invalid date format', () => {
      const payload = { ...validBasePayload, startDate: 'invalid-date' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'startDate' && 
        issue.message.includes('valid ISO timestamp')
      ))
    })

    test('rejects non-string timestamps', () => {
      const payload = { ...validBasePayload, startDate: 1234567890 }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })
  })

  describe('Date relationship validation', () => {
    test('rejects endDate equal to startDate', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-01-01T00:00:00.000Z',
        endDate: '2030-01-01T00:00:00.000Z',
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'endDate' && 
        issue.message.includes('greater than startDate')
      ))
    })

    test('rejects endDate before startDate', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-06-01T00:00:00.000Z',
        endDate: '2030-01-01T00:00:00.000Z',
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'endDate' && 
        issue.message.includes('greater than startDate')
      ))
    })

    test('accepts endDate after startDate', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-01-01T00:00:00.000Z',
        endDate: '2030-06-01T00:00:00.000Z',
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })
  })

  describe('Milestones validation', () => {
    test('rejects empty milestones array', () => {
      const payload = { ...validBasePayload, milestones: [] }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'milestones' && 
        issue.message.includes('at least one item')
      ))
    })

    test('rejects milestone with empty title', () => {
      const payload = {
        ...validBasePayload,
        milestones: [{ ...validBasePayload.milestones[0], title: '' }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'milestones.0.title'
      ))
    })

    test('rejects milestone with whitespace-only title', () => {
      const payload = {
        ...validBasePayload,
        milestones: [{ ...validBasePayload.milestones[0], title: '   ' }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('accepts milestone with description', () => {
      const payload = {
        ...validBasePayload,
        milestones: [{ 
          ...validBasePayload.milestones[0], 
          description: 'Optional description' 
        }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('rejects milestone dueDate before startDate', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-06-01T00:00:00.000Z',
        milestones: [{ 
          ...validBasePayload.milestones[0], 
          dueDate: '2030-05-01T00:00:00.000Z' 
        }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'milestones.0.dueDate' && 
        issue.message.includes('cannot be before startDate')
      ))
    })

    test('accepts milestone dueDate equal to startDate', () => {
      const payload = {
        ...validBasePayload,
        startDate: '2030-01-01T00:00:00.000Z',
        milestones: [{ 
          ...validBasePayload.milestones[0], 
          dueDate: '2030-01-01T00:00:00.000Z' 
        }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('rejects milestone with invalid amount', () => {
      const payload = {
        ...validBasePayload,
        milestones: [{ 
          ...validBasePayload.milestones[0], 
          amount: '-100' 
        }]
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('rejects total milestone amounts exceeding vault amount', () => {
      const payload = {
        ...validBasePayload,
        amount: '1000',
        milestones: [
          { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '600' },
          { title: 'M2', dueDate: '2030-03-01T00:00:00.000Z', amount: '500' },
        ],
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      assert.ok(result.error.issues.some(issue => 
        issue.path.join('.') === 'milestones' && 
        issue.message.includes('Total milestone amount cannot exceed vault amount')
      ))
    })

    test('accepts total milestone amounts equal to vault amount', () => {
      const payload = {
        ...validBasePayload,
        amount: '1000',
        milestones: [
          { title: 'M1', dueDate: '2030-02-01T00:00:00.000Z', amount: '600' },
          { title: 'M2', dueDate: '2030-03-01T00:00:00.000Z', amount: '400' },
        ],
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('handles large number of milestones efficiently', () => {
      const manyMilestones = Array.from({ length: 100 }, (_, i) => ({
        title: `Milestone ${i}`,
        dueDate: `2030-${String(Math.floor(i / 31) + 1).padStart(2, '0')}-${String((i % 31) + 1).padStart(2, '0')}T00:00:00.000Z`,
        amount: '10',
      }))
      
      const payload = {
        ...validBasePayload,
        amount: '1000',
        milestones: manyMilestones,
      }
      
      const start = Date.now()
      const result = createVaultSchema.safeParse(payload)
      const duration = Date.now() - start
      
      assert.equal(result.success, true)
      assert.ok(duration < 100, 'Validation should complete quickly even with many milestones')
    })
  })

  describe('Optional fields validation', () => {
    test('accepts payload with creator', () => {
      const payload = {
        ...validBasePayload,
        creator: validStellarAddress,
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('accepts payload without creator', () => {
      const payload = { ...validBasePayload }
      delete payload.creator
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('accepts payload with onChain object', () => {
      const payload = {
        ...validBasePayload,
        onChain: {
          mode: 'build' as const,
          contractId: 'contract-123',
          networkPassphrase: 'test-network',
          sourceAccount: validStellarAddress,
        },
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('accepts payload without onChain object', () => {
      const payload = { ...validBasePayload }
      delete payload.onChain
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
    })

    test('accepts onChain with default mode', () => {
      const payload = {
        ...validBasePayload,
        onChain: {},
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, true)
      assert.equal(result.data.onChain?.mode, 'build')
    })

    test('rejects invalid onChain mode', () => {
      const payload = {
        ...validBasePayload,
        onChain: {
          mode: 'invalid' as any,
        },
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })
  })

  describe('Security and boundary tests', () => {
    test('handles extremely large amounts safely', () => {
      const payload = {
        ...validBasePayload,
        amount: '99999999999999999999999999999999999999999999999999',
      }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
    })

    test('handles maliciously long strings', () => {
      const longString = 'A'.repeat(100000)
      const payload = {
        ...validBasePayload,
        milestones: [{
          title: longString,
          dueDate: '2030-02-01T00:00:00.000Z',
          amount: '100',
        }],
      }
      
      const start = Date.now()
      const result = createVaultSchema.safeParse(payload)
      const duration = Date.now() - start
      
      assert.equal(result.success, false)
      assert.ok(duration < 1000, 'Should reject malicious input quickly')
    })

    test('handles deeply nested objects safely', () => {
      const maliciousPayload = {
        ...validBasePayload,
        __proto__: { polluted: true },
        constructor: { prototype: { polluted: true } },
      }
      
      const result = createVaultSchema.safeParse(maliciousPayload)
      assert.equal(result.success, true)
      assert.ok((result.data as any).polluted === undefined)
    })

    test('validates type safety strictly', () => {
      const invalidTypes = [
        { ...validBasePayload, amount: null },
        { ...validBasePayload, amount: undefined },
        { ...validBasePayload, amount: {} },
        { ...validBasePayload, amount: [] },
        { ...validBasePayload, startDate: true },
        { ...validBasePayload, verifier: 123 },
        { ...validBasePayload, destinations: 'not-an-object' },
        { ...validBasePayload, milestones: 'not-an-array' },
      ]

      invalidTypes.forEach((payload, index) => {
        const result = createVaultSchema.safeParse(payload)
        assert.equal(result.success, false, `Should reject invalid type at index ${index}`)
      })
    })
  })

  describe('Error formatting consistency', () => {
    test('provides consistent error paths', () => {
      const payload = {
        ...validBasePayload,
        amount: '-100',
        verifier: 'invalid',
        startDate: 'invalid-date',
      }
      
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      
      const paths = result.error.issues.map(issue => issue.path.join('.'))
      assert.ok(paths.includes('amount'))
      assert.ok(paths.includes('verifier'))
      assert.ok(paths.includes('startDate'))
    })

    test('provides meaningful error messages', () => {
      const payload = { ...validBasePayload, amount: '-100' }
      const result = createVaultSchema.safeParse(payload)
      assert.equal(result.success, false)
      
      const amountError = result.error.issues.find(issue => 
        issue.path.join('.') === 'amount'
      )
      assert.ok(amountError)
      assert.ok(amountError.message.length > 0)
      assert.ok(typeof amountError.message === 'string')
    })
  })
})
