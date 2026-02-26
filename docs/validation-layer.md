# Input Validation & Sanitization Layer

This document describes the comprehensive input validation and sanitization layer implemented for the Disciplr-backend API.

## Overview

The validation layer provides:
- Request schema validation using Zod
- Input sanitization for security (XSS prevention, injection attacks)
- Unified error response format
- Automatic data cleaning and normalization

## Architecture

### Core Components

1. **Validation Middleware** (`/src/middleware/validation/index.ts`)
   - `createValidationMiddleware()` - Main middleware factory
   - `sanitizeInput()` - Individual field sanitization
   - `sanitizeObject()` - Object-level sanitization
   - `formatZodError()` - Error formatting

2. **Request Schemas** (`/src/middleware/validation/schemas.ts`)
   - Zod schemas for all API endpoints
   - Type-safe validation rules
   - Reusable schema components

3. **Error Response Format**
   ```typescript
   interface ValidationErrorResponse {
     success: false
     error: {
       type: 'validation'
       message: string
       details: ValidationFieldError[]
     }
     timestamp: string
   }
   ```

## Implementation Details

### Validation Middleware Usage

```typescript
import { createValidationMiddleware } from '../middleware/validation/index.js'
import { createApiKeySchema } from '../middleware/validation/schemas.js'

// Apply to route
router.post('/', 
  createValidationMiddleware(createApiKeySchema, { source: 'body' }),
  (req, res) => {
    // req.body is now validated and sanitized
    const { label, scopes, orgId } = req.body
    // ... business logic
  }
)
```

### Sanitization Rules

The sanitization applies the following rules automatically:

1. **String Fields**
   - Trim whitespace
   - Strip HTML tags
   - Normalize email addresses (if detected)
   - Escape HTML entities (when enabled)

2. **Email Detection**
   - Field names containing 'email'
   - Values containing '@' symbol
   - Automatic normalization to lowercase

3. **Security Features**
   - XSS prevention through HTML stripping
   - Control character removal
   - Input length validation

### Schema Examples

#### API Key Creation
```typescript
export const createApiKeySchema = z.object({
  label: z.string()
    .min(1, 'Label is required')
    .max(100, 'Label must be 100 characters or less')
    .trim(),
  scopes: z.array(z.string().trim())
    .min(1, 'At least one scope is required')
    .max(10, 'Maximum 10 scopes allowed'),
  orgId: z.string()
    .max(50, 'Organization ID must be 50 characters or less')
    .trim()
    .optional()
})
```

#### Email Validation
```typescript
export const sendTestEmailSchema = z.object({
  to: z.string()
    .email('Invalid email address')
    .max(255, 'Email address too long'),
  eventType: z.string()
    .max(50, 'Event type must be 50 characters or less')
    .optional(),
  data: z.record(z.unknown())
    .optional()
})
```

## API Endpoints with Validation

### API Keys
- `POST /api-keys` - API key creation
- `POST /api-keys/:id/revoke` - API key revocation

### Email Services
- `POST /email/send/test` - Test email sending
- `POST /email/send/vault-created` - Vault creation notifications
- `POST /email/send/deadline-approaching` - Deadline notifications

### Vaults
- `GET /vaults` - List vaults (with query validation)
- `POST /vaults` - Create vault
- `GET /vaults/:id` - Get specific vault

### Privacy
- `GET /privacy/export` - Export user data
- `DELETE /privacy/account` - Delete user account

### Analytics & Transactions
- `GET /analytics` - Analytics data (with query validation)
- `GET /transactions` - Transaction list (with query validation)

## Error Handling

### Validation Error Response

```json
{
  "success": false,
  "error": {
    "type": "validation",
    "message": "Request validation failed",
    "details": [
      {
        "field": "email",
        "message": "Invalid email address",
        "code": "invalid_string"
      },
      {
        "field": "label",
        "message": "Label is required",
        "code": "too_small"
      }
    ]
  },
  "timestamp": "2024-02-26T12:00:00.000Z"
}
```

### Error Codes

- `too_small` - Field below minimum length/size
- `too_big` - Field exceeds maximum length/size
- `invalid_string` - String format validation failed
- `invalid_format` - Specific format validation failed (email, datetime, etc.)
- `invalid_type` - Wrong data type provided
- `missing_data` - Required request data missing

## Security Considerations

### XSS Prevention
- HTML tags are stripped from all string inputs
- Script content is removed
- Control characters are filtered

### Injection Prevention
- Input length limits enforced
- Special character handling
- Data type validation

### Email Security
- Email format validation
- Normalization prevents email spoofing
- Domain validation through validator.js

## Testing

### Unit Tests
- Validation utility functions
- Sanitization logic
- Error formatting
- Schema validation

### Integration Tests
- Full API endpoint validation
- Error response format
- Sanitization in request flow

### Test Coverage
- All validation schemas
- Error scenarios
- Edge cases
- Security test cases

## Performance Considerations

- Validation runs before business logic
- Early rejection of invalid requests
- Minimal overhead for valid requests
- Schema compilation cached by Zod

## Migration Guide

### For Existing API Consumers

1. **Error Format Changes**
   - Old: `{ error: "message" }`
   - New: Structured validation errors with field details

2. **Input Sanitization**
   - Whitespace automatically trimmed
   - HTML content stripped
   - Email addresses normalized

3. **Backward Compatibility**
   - Valid requests continue to work
   - More restrictive validation for invalid inputs
   - Better error messages for debugging

### For Developers

1. **Adding New Endpoints**
   ```typescript
   // 1. Define schema
   const newEndpointSchema = z.object({
     field1: z.string().min(1),
     field2: z.number().positive()
   })
   
   // 2. Apply middleware
   router.post('/endpoint',
     createValidationMiddleware(newEndpointSchema, { source: 'body' }),
     handler
   )
   ```

2. **Custom Validation**
   - Extend existing schemas
   - Add custom refinements using Zod's `.refine()`
   - Implement domain-specific validation rules

## Configuration

### Environment Variables
No additional configuration required. The validation layer works out of the box.

### Customization
- Modify sanitization rules in `sanitizeInput()`
- Extend schemas in `schemas.ts`
- Add custom error formatting in `formatZodError()`

## Dependencies

- `zod` - Schema validation and TypeScript integration
- `validator.js` - Input sanitization and validation utilities

## Future Enhancements

1. **Advanced Sanitization**
   - Markdown sanitization
   - URL validation and normalization
   - File upload validation

2. **Performance Optimizations**
   - Request validation caching
   - Async validation support
   - Streaming validation for large payloads

3. **Extended Features**
   - Conditional validation rules
   - Cross-field validation
   - Custom sanitization pipelines
