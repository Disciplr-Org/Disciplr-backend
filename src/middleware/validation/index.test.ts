import { describe, test, expect, jest, beforeEach } from '@jest/globals'
import { Request, Response, NextFunction } from 'express'
import { 
  createValidationMiddleware, 
  sanitizeInput, 
  sanitizeObject, 
  formatZodError,
  ValidationErrorResponse 
} from './index.js'
import { z } from 'zod'

describe('Validation Middleware', () => {
  let mockRequest: Partial<Request>
  let mockResponse: Partial<Response>
  let mockNext: NextFunction

  beforeEach(() => {
    mockRequest = {}
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    } as any
    mockNext = jest.fn()
  })

  describe('createValidationMiddleware', () => {
    const testSchema = z.object({
      name: z.string().min(1).max(50),
      email: z.string().email(),
      age: z.number().min(0).max(120).optional(),
    })

    test('should pass validation with valid data', () => {
      mockRequest.body = {
        name: 'John Doe',
        email: 'john@example.com',
        age: 30,
      }

      const middleware = createValidationMiddleware(testSchema, { source: 'body' })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(mockResponse.status).not.toHaveBeenCalled()
      expect(mockResponse.json).not.toHaveBeenCalled()
    })

    test('should fail validation with invalid data', () => {
      mockRequest.body = {
        name: '',
        email: 'invalid-email',
        age: -5,
      }

      const middleware = createValidationMiddleware(testSchema, { source: 'body' })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).not.toHaveBeenCalled()
      expect(mockResponse.status).toHaveBeenCalledWith(400)
      
      const response = (mockResponse.json as jest.Mock).mock.calls[0][0] as ValidationErrorResponse
      expect(response.success).toBe(false)
      expect(response.error.type).toBe('validation')
      expect(response.error.details).toHaveLength(3)
    })

    test('should handle missing request data', () => {
      const middleware = createValidationMiddleware(testSchema, { source: 'body' })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).not.toHaveBeenCalled()
      expect(mockResponse.status).toHaveBeenCalledWith(400)
      
      const response = (mockResponse.json as jest.Mock).mock.calls[0][0] as ValidationErrorResponse
      expect(response.error.details[0].field).toBe('body')
      expect(response.error.details[0].code).toBe('missing_data')
    })

    test('should sanitize data when enabled', () => {
      mockRequest.body = {
        name: '  John Doe  ',
        email: 'john@example.com  ',
        age: 30,
      }

      const middleware = createValidationMiddleware(testSchema, { source: 'body', sanitize: true })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
      expect(mockRequest.body.name).toBe('John Doe')
      expect(mockRequest.body.email).toBe('john@example.com')
    })

    test('should validate query parameters', () => {
      const querySchema = z.object({
        page: z.string().regex(/^\d+$/).optional(),
        limit: z.string().regex(/^\d+$/).optional(),
      })

      mockRequest.query = {
        page: '1',
        limit: '10',
      }

      const middleware = createValidationMiddleware(querySchema, { source: 'query' })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
    })

    test('should validate route parameters', () => {
      const paramsSchema = z.object({
        id: z.string().regex(/^user-\d+$/),
      })

      mockRequest.params = {
        id: 'user-123',
      }

      const middleware = createValidationMiddleware(paramsSchema, { source: 'params' })
      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).toHaveBeenCalledWith()
    })

    test('should handle internal errors gracefully', () => {
      const errorSchema = z.object({
        name: z.string(),
      })

      mockRequest.body = {
        name: 'John',
      }

      const middleware = createValidationMiddleware(errorSchema, { source: 'body' })
      
      // Mock a scenario where schema parsing throws an unexpected error
      const originalSafeParse = errorSchema.safeParse
      errorSchema.safeParse = jest.fn().mockReturnValue({
        success: false,
        error: new Error('Unexpected error')
      } as any)

      middleware(mockRequest as Request, mockResponse as Response, mockNext)

      expect(mockNext).not.toHaveBeenCalled()
      expect(mockResponse.status).toHaveBeenCalledWith(500)
      
      const response = (mockResponse.json as jest.Mock).mock.calls[0][0] as ValidationErrorResponse
      expect(response.error.type).toBe('validation')
      expect(response.error.details[0].code).toBe('internal_error')

      // Restore original method
      errorSchema.safeParse = originalSafeParse
    })
  })

  describe('sanitizeInput', () => {
    test('should trim strings', () => {
      const result = sanitizeInput('  hello world  ', { trim: true })
      expect(result).toBe('hello world')
    })

    test('should escape HTML', () => {
      const result = sanitizeInput('<script>alert("xss")</script>', { escape: true })
      expect(result).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;&#x2F;script&gt;')
    })

    test('should strip dangerous characters', () => {
      const result = sanitizeInput('hello\x00world', { stripHtml: true })
      expect(result).toBe('helloworld')
    })

    test('should normalize email', () => {
      const result = sanitizeInput('John.Doe@EXAMPLE.COM', { normalizeEmail: true })
      expect(result).toBe('john.doe@example.com')
    })

    test('should return non-string values unchanged', () => {
      const number = sanitizeInput(123, { trim: true })
      expect(number).toBe(123)

      const boolean = sanitizeInput(true, { trim: true })
      expect(boolean).toBe(true)

      const object = sanitizeInput({ key: 'value' }, { trim: true })
      expect(object).toEqual({ key: 'value' })
    })

    test('should apply multiple sanitization options', () => {
      const result = sanitizeInput('  <script>test@example.com</script>  ', {
        trim: true,
        escape: true,
        normalizeEmail: true,
      })
      expect(result).toBe('&lt;script&gt;test@example.com&lt;&#x2F;script&gt;')
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

      expect(result.name).toBe('John Doe')
      expect(result.email).toBe('john@example.com')
      expect(result.description).toBe('A test description')
      expect(result.count).toBe(42)
    })

    test('should handle null/undefined objects', () => {
      expect(sanitizeObject(null, testSchema)).toBe(null)
      expect(sanitizeObject(undefined, testSchema)).toBe(undefined)
    })

    test('should handle non-object values', () => {
      expect(sanitizeObject('string', testSchema)).toBe('string')
      expect(sanitizeObject(123, testSchema)).toBe(123)
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
        
        expect(formatted).toHaveLength(2)
        expect(formatted[0]).toMatchObject({
          field: 'name',
          code: 'too_small',
        })
        expect(formatted[1]).toMatchObject({
          field: 'email',
          code: 'invalid_string',
        })
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
        
        expect(formatted).toHaveLength(1)
        expect(formatted[0].field).toBe('user.name')
      }
    })
  })
})
