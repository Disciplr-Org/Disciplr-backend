# Content-Type Enforcement

This document describes the JSON content-type enforcement middleware implemented in the Disciplr backend API.

## Overview

The Disciplr backend enforces strict `Content-Type: application/json` headers for all endpoints that require JSON request bodies. This security measure ensures that:

1. Only properly formatted JSON payloads are processed
2. Content-type injection attacks are prevented
3. API contract violations are caught early
4. Consistent error responses are provided

## Middleware Implementation

### `requireJson` Middleware

The `requireJson` middleware validates the `Content-Type` header before request body parsing.

**Location:** `src/middleware/requireJson.ts`

#### Behavior

- **GET, HEAD, DELETE requests**: Automatically bypass content-type validation (these methods typically don't have request bodies)
- **POST, PUT, PATCH requests**: Enforce `Content-Type: application/json` when a request body is present
- **Empty requests**: Allow requests without bodies to proceed without content-type validation

#### Request Body Detection

The middleware detects request bodies using:
- `Content-Length` header (when > 0)
- `Transfer-Encoding: chunked` header

#### Error Responses

**Missing Content-Type (415):**
```json
{
  "success": false,
  "error": "Unsupported Media Type",
  "message": "Content-Type header is required for requests with a body"
}
```

**Invalid Content-Type (415):**
```json
{
  "success": false,
  "error": "Unsupported Media Type", 
  "message": "Content-Type must be application/json"
}
```

### `validateJsonPayload` Middleware

The `validateJsonPayload` middleware catches JSON parsing errors and provides consistent error responses.

#### Error Response

**Invalid JSON (400):**
```json
{
  "success": false,
  "error": "Bad Request",
  "message": "Invalid JSON payload"
}
```

## Supported Content-Types

### Valid Content-Types

- `application/json`
- `application/json; charset=utf-8`
- `application/json; charset=iso-8859-1`
- Case-insensitive variants (e.g., `APPLICATION/JSON`)

### Invalid Content-Types

- `text/plain`
- `text/html`
- `application/xml`
- `multipart/form-data`
- `application/x-www-form-urlencoded`
- Any content-type not starting with `application/json`

## Endpoint Coverage

### Auth Endpoints

All authentication endpoints require JSON content-type:

- `POST /api/auth/login`
- `POST /api/auth/register`
- `POST /api/auth/refresh`

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret"}'
```

### Vault Endpoints

Vault endpoints that modify data require JSON content-type:

- `POST /api/vaults` (create vault)
- `PUT /api/vaults/:id` (update vault)

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/vaults \
  -H "Content-Type: application/json" \
  -d '{"name": "My Vault", "description": "Secure storage"}'
```

### Job Endpoints

Job management endpoints require JSON content-type:

- `POST /api/jobs/enqueue` (enqueue single job)
- `POST /api/jobs/bulk` (enqueue multiple jobs)

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/jobs/enqueue \
  -H "Content-Type: application/json" \
  -d '{"type": "data-processing", "payload": {"data": "sample"}}'
```

### Admin Endpoints

Admin endpoints that modify data require JSON content-type where applicable.

### Read-Only Endpoints

GET, HEAD, and DELETE endpoints do not require content-type validation:

- `GET /api/admin/audit-logs`
- `GET /api/vaults`
- `GET /api/jobs`
- `DELETE /api/vaults/:id`

## Security Considerations

### Prevention of Content-Type Injection

The middleware prevents attacks where malicious clients attempt to:
- Bypass JSON parsing by using alternative content-types
- Inject XML or other formats to exploit parser vulnerabilities
- Send malformed data that could cause unexpected behavior

### Bypass Prevention

The middleware is designed to prevent bypass through:
- **Parameter stuffing**: Only allows charset parameters in JSON content-type
- **Case variation**: Case-insensitive matching prevents case-based bypasses
- **Whitespace manipulation**: Trims whitespace from content-type headers
- **Encoding tricks**: Validates the actual content-type string, not just prefixes

## Testing

### Test Coverage

The implementation includes comprehensive test coverage in `src/tests/contentType.test.ts`:

- **Method-specific tests**: GET, POST, PUT, PATCH, DELETE behavior
- **Content-type validation**: Valid and invalid content-types
- **JSON parsing**: Valid and invalid JSON payloads
- **Edge cases**: Empty bodies, chunked encoding, case sensitivity
- **Security tests**: Bypass attempts, parameter validation
- **Integration tests**: Real endpoint scenarios

### Running Tests

```bash
# Run all tests
npm test

# Run content-type tests specifically
npm test -- --testNamePattern="Content-Type Enforcement"

# Run with coverage
npm test -- --coverage
```

### Test Matrix

| Method | Valid Content-Type | Invalid Content-Type | No Content-Type | Empty Body |
|--------|-------------------|---------------------|----------------|------------|
| GET    | ✅                | ✅                  | ✅             | ✅         |
| POST   | ✅                | ❌ (415)            | ❌ (415)       | ✅         |
| PUT    | ✅                | ❌ (415)            | ❌ (415)       | ✅         |
| PATCH  | ✅                | ❌ (415)            | ❌ (415)       | ✅         |
| DELETE | ✅                | ✅                  | ✅             | ✅         |

## Error Handling

### Consistent Error Format

All content-type related errors follow the same response format:

```json
{
  "success": false,
  "error": "Error Type",
  "message": "Human-readable error description"
}
```

### HTTP Status Codes

- **415 Unsupported Media Type**: Invalid or missing content-type
- **400 Bad Request**: Invalid JSON payload
- **200 OK**: Successful processing with valid content-type

## Migration Guide

### For API Consumers

1. **Always include `Content-Type: application/json`** for POST/PUT/PATCH requests with bodies
2. **Ensure valid JSON** in request payloads
3. **Handle 415 and 400 error responses** appropriately
4. **Update client libraries** to include proper headers

### Example Migration

**Before (may work but not recommended):**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -d '{"email": "user@example.com", "password": "secret"}'
```

**After (required):**
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "secret"}'
```

## Performance Considerations

### Middleware Overhead

The content-type enforcement middleware adds minimal overhead:
- Header validation: ~0.1ms per request
- No body parsing until content-type is validated
- Early rejection of invalid requests saves processing time

### Benefits

- **Reduced error rates**: Invalid requests are caught early
- **Security**: Prevents parser-based attacks
- **Consistency**: Uniform error handling across all endpoints
- **Debugging**: Clear error messages help developers

## Configuration

### Global Application

The middleware is applied globally in `src/index.ts`:

```typescript
// JSON content-type enforcement middleware
app.use(requireJson);
app.use(express.json({ limit: '10mb' }));
app.use(validateJsonPayload);
```

### Route-Specific Application

For endpoints requiring additional validation, the middleware can be applied per-route:

```typescript
router.post('/endpoint', requireJson, (req, res) => {
  // Route logic
});
```

## Troubleshooting

### Common Issues

**415 Error with JSON Content-Type**
- Check for typos in the `Content-Type` header
- Ensure no extra parameters except charset
- Verify header case (should be case-insensitive)

**400 Error with Valid JSON**
- Check for JSON syntax errors
- Verify proper escaping of special characters
- Use JSON linters to validate payloads

**Requests Unexpectedly Rejected**
- Verify the request method (GET/DELETE don't need content-type)
- Check if request actually has a body (Content-Length > 0)
- Ensure middleware is applied in correct order

### Debugging

Enable debug logging to trace middleware execution:

```bash
DEBUG=express:* npm start
```

## Future Enhancements

### Potential Improvements

1. **Content-Type Whitelisting**: Allow specific additional content-types per endpoint
2. **Schema Validation**: Integrate with JSON schema validation
3. **Rate Limiting**: Add rate limiting for content-type violations
4. **Metrics**: Track content-type violation rates for monitoring

### Backward Compatibility

The implementation maintains backward compatibility for:
- Existing GET/DELETE endpoints
- Empty POST/PUT/PATCH requests
- Valid JSON requests with proper headers

## Conclusion

The content-type enforcement middleware provides a robust security layer that ensures API contract compliance while maintaining good developer experience through clear error messages and comprehensive testing coverage.
