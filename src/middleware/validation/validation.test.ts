import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeInput, sanitizeObject, formatZodError } from './index.js'
import { z } from 'zod'

describe('Validation Utilities', () => {
  describe('sanitizeInput', () => {
    test('should trim strings', () => {
      const result = sanitizeInput('  hello world  ', { trim: true })
      assert.equal(result, 'hello world')
    })

    test('should escape HTML', () => {
      const result = sanitizeInput('<script>alert("xss")</script>', { escape: true })
      assert.equal(result, '&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;')
    })

    test('should strip dangerous characters', () => {
      const result = sanitizeInput('hello\x00world', { stripHtml: true })
      assert.equal(result, 'helloworld')
    })

    test('should normalize email', () => {
      const result = sanitizeInput('John.Doe@EXAMPLE.COM', { normalizeEmail: true })
      assert.equal(result, 'john.doe@example.com')
    })

    test('should return non-string values unchanged', () => {
      const number = sanitizeInput(123, { trim: true })
      assert.equal(number, 123)

      const boolean = sanitizeInput(true, { trim: true })
      assert.equal(boolean, true)

      const object = sanitizeInput({ key: 'value' }, { trim: true })
      assert.deepEqual(object, { key: 'value' })
    })

    test('should apply multiple sanitization options', () => {
      const result = sanitizeInput('  <script>test@example.com</script>  ', {
        trim: true,
        escape: true,
        normalizeEmail: true,
      })
      assert.equal(result, '&lt;script&gt;test@example.com&lt;&#x2F;script&gt;')
    })
  })

  describe('sanitizeObject', () => {
    const testSchema = z.object({
      name: z.string(),
      email: z.string().email(),
      description: z.string().optional(),
      count: z.number().optional(),
    })

    test('should sanitize string fields in object', () => {
      const input = {
        name: '  John Doe  ',
        email: 'JOHN@EXAMPLE.COM',
        description: '  A <script>test</script> description  ',
        count: 42,
      }

      const result = sanitizeObject(input, testSchema)
      
      assert.equal(result.name, 'John Doe')
      // Email should be normalized now
      assert.equal(result.email, 'john@example.com')
      assert.equal(result.description, 'A test description')
      assert.equal(result.count, 42)
    })

    test('should handle null/undefined objects', () => {
      assert.equal(sanitizeObject(null, testSchema), null)
      assert.equal(sanitizeObject(undefined, testSchema), undefined)
    })

    test('should handle non-object values', () => {
      assert.equal(sanitizeObject('string', testSchema), 'string')
      assert.equal(sanitizeObject(123, testSchema), 123)
    })
  })

  describe('formatZodError', () => {
    test('should format Zod validation errors', () => {
      const schema = z.object({
        name: z.string().min(3),
        email: z.string().email(),
      })

      const result = schema.safeParse({ name: 'Jo', email: 'invalid' })
      
      if (!result.success) {
        const formatted = formatZodError(result.error)
        
        assert.equal(formatted.length, 2)
        assert.equal(formatted[0].field, 'name')
        assert.equal(formatted[0].code, 'too_small')
        assert.equal(formatted[1].field, 'email')
        // The actual code might be 'invalid_format' for email validation
        assert.ok(formatted[1].code === 'invalid_string' || formatted[1].code === 'invalid_format')
      }
    })

    test('should handle nested field paths', () => {
      const schema = z.object({
        user: z.object({
          name: z.string().min(3),
        }),
      })

      const result = schema.safeParse({ user: { name: 'Jo' } })
      
      if (!result.success) {
        const formatted = formatZodError(result.error)
        
        assert.equal(formatted.length, 1)
        assert.equal(formatted[0].field, 'user.name')
      }
    })
  })
})
