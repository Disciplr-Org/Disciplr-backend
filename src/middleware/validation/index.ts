import { Request, Response, NextFunction } from 'express'
import { z, ZodSchema, ZodError } from 'zod'
import validator from 'validator'

export interface ValidationFieldError {
  field: string
  message: string
  code: string
}

export interface ValidationErrorResponse {
  success: false
  error: {
    type: 'validation'
    message: string
    details: ValidationFieldError[]
  }
  timestamp: string
}

export interface SanitizeOptions {
  trim?: boolean
  escape?: boolean
  stripHtml?: boolean
  normalizeEmail?: boolean
}

export class ValidationError extends Error {
  public details: ValidationFieldError[]

  constructor(details: ValidationFieldError[]) {
    super('Validation failed')
    this.name = 'ValidationError'
    this.details = details
  }
}

export function sanitizeInput(value: any, options: SanitizeOptions = {}): any {
  if (typeof value !== 'string') return value

  let sanitized = value

  if (options.trim) {
    sanitized = sanitized.trim()
  }

  if (options.escape) {
    sanitized = validator.escape(sanitized)
  }

  if (options.stripHtml) {
    // stripLow removes control characters, not HTML tags
    // For HTML stripping, we need a different approach
    sanitized = validator.stripLow(sanitized)
    sanitized = sanitized.replace(/<[^>]*>/g, '')
  }

  if (options.normalizeEmail && validator.isEmail(sanitized)) {
    sanitized = validator.normalizeEmail(sanitized) || sanitized
  }

  return sanitized
}

export function sanitizeObject(obj: any, schema: ZodSchema): any {
  if (!obj || typeof obj !== 'object') return obj

  const sanitized: any = {}
  
  try {
    // Get the shape from the schema if it's a ZodObject
    const schemaDef = (schema as any).def
    
    let shape = null
    
    if (schemaDef?.type === 'object') {
      shape = schemaDef.shape
    }
    
    if (!shape) {
      // If we can't get the shape, return original object
      return obj
    }

    for (const [key, value] of Object.entries(obj)) {
      const fieldSchema = shape[key]
      if (fieldSchema) {
        const fieldDef = (fieldSchema as any).def
        const isString = fieldDef?.type === 'string'
        const isOptional = fieldDef?.type === 'optional'
        
        // Simple email detection - check if field name contains 'email' or value looks like email
        const isEmail = (isString || isOptional) && (
          key.toLowerCase().includes('email') || 
          (typeof value === 'string' && value.includes('@'))
        )
        
        if (isString) {
          sanitized[key] = sanitizeInput(value, {
            trim: true,
            escape: false,
            stripHtml: true,
            normalizeEmail: isEmail
          })
        } else if (isOptional) {
          // Handle optional string fields (wrapped in ZodOptional)
          const innerDef = fieldDef?.innerType?.def
          const isOptionalString = innerDef?.type === 'string'
          
          if (isOptionalString) {
            sanitized[key] = sanitizeInput(value, {
              trim: true,
              escape: false,
              stripHtml: true,
              normalizeEmail: isEmail
            })
          } else {
            sanitized[key] = value
          }
        } else {
          sanitized[key] = value
        }
      } else {
        sanitized[key] = value
      }
    }

    return sanitized
  } catch (error) {
    // If sanitization fails, return original object
    return obj
  }
}

export function formatZodError(error: ZodError): ValidationFieldError[] {
  return error.issues.map(issue => ({
    field: issue.path.join('.'),
    message: issue.message,
    code: issue.code
  }))
}

export function createValidationMiddleware<T extends ZodSchema>(
  schema: T,
  options: {
    sanitize?: boolean
    source?: 'body' | 'query' | 'params'
  } = {}
) {
  const { sanitize = true, source = 'body' } = options

  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const data = req[source]
      
      if (!data) {
        const errorResponse: ValidationErrorResponse = {
          success: false,
          error: {
            type: 'validation',
            message: `Missing ${source} data`,
            details: [{
              field: source,
              message: `Request ${source} is required`,
              code: 'missing_data'
            }]
          },
          timestamp: new Date().toISOString()
        }
        return res.status(400).json(errorResponse)
      }

      const result = schema.safeParse(data)

      if (!result.success) {
        const validationErrors = formatZodError(result.error)
        const errorResponse: ValidationErrorResponse = {
          success: false,
          error: {
            type: 'validation',
            message: 'Request validation failed',
            details: validationErrors
          },
          timestamp: new Date().toISOString()
        }
        return res.status(400).json(errorResponse)
      }

      if (sanitize) {
        const sanitizedData = sanitizeObject(result.data, schema)
        req[source] = sanitizedData
      } else {
        req[source] = result.data
      }

      next()
    } catch (error) {
      console.error('Validation middleware error:', error)
      const errorResponse: ValidationErrorResponse = {
        success: false,
        error: {
          type: 'validation',
          message: 'Internal validation error',
          details: [{
            field: 'internal',
            message: 'An unexpected error occurred during validation',
            code: 'internal_error'
          }]
        },
        timestamp: new Date().toISOString()
      }
      res.status(500).json(errorResponse)
    }
  }
}
