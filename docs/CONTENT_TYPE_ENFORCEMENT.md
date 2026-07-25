# Content-Type Enforcement API Documentation

## Overview

This document describes the implementation of strict content-type enforcement for JSON endpoints in the Disciplr backend. The middleware ensures that all endpoints requiring request bodies receive properly formatted JSON with the correct `Content-Type` header.

## Security Features

### Content-Type Validation
- **Enforcement**: All POST, PUT, PATCH, and DELETE requests with bodies must include `Content-Type: application/json`
- **Charset Validation**: Only UTF-8 charset is supported for JSON payloads
- **Bypass Prevention**: Middleware prevents bypass attempts using alternate content types

### Request Body Limits
- **Per-route caps**: Smaller JSON limits are enforced for sensitive routes before the global parser runs
- **Auth routes**: `/api/auth/*` requests are capped at `8 KB`
- **Jobs enqueue**: `POST /api/jobs/enqueue` is capped at `32 KB`
- **Early rejection**: `Content-Length` headers above the configured route cap are rejected with `413 Payload Too Large`
- **Streaming fallback**: Route-scoped `express.json({ limit })` middleware still enforces the cap when `Content-Length` is omitted and the client uses chunked transfer

### Error Handling
- **Consistent Error Envelope**: All content-type errors return standardized error responses
- **HTTP Status Codes**: 
  - `415 Unsupported Media Type` for invalid content types
  - `400 Bad Request` for malformed JSON (handled by Express)

## Implementation Details

### Middleware Location
`src/middleware/requireJson.ts`

### Core Functions

#### `requireJson(options?)`
Main middleware factory that:
- Allows GET, HEAD, OPTIONS requests to pass through (no body expected)
- Validates `Content-Type` header for requests with bodies
- Optionally rejects oversized request bodies using `maxBytes`
- Returns `415` status for unsupported media types
- Validates charset parameter (UTF-8 only)

#### `requireJsonForMethods(methods)`
Factory function that creates middleware for specific HTTP methods only.

### Shared Limits
`src/middleware/requestBodyLimits.ts`

- `AUTH_JSON_MAX_BYTES = 8 * 1024`
- `JOBS_JSON_MAX_BYTES = 32 * 1024`

### Parser Ordering
Route-specific JSON parsers are registered before the global `express.json()` middleware in `src/app.ts`:

- `app.use('/api/auth', express.json({ limit: AUTH_JSON_MAX_BYTES }))`
- `app.use('/api/jobs/enqueue', express.json({ limit: JOBS_JSON_MAX_BYTES }))`

This ensures the smaller caps are enforced even when clients omit `Content-Length`.

### Applied Endpoints

#### Authentication Routes (`/api/auth/*`)
- `POST /auth/register` - User registration
- `POST /auth/login` - User login  
- `POST /auth/refresh` - Token refresh
- `POST /auth/logout` - User logout
- `POST /auth/logout-all` - Logout from all devices
- `POST /auth/users/:id/role` - Role management
- **Body limit**: `8 KB`

#### Vault Routes (`/api/vaults/*`)
- `POST /api/vaults` - Create new vault
- `POST /api/vaults/:id/cancel` - Cancel vault

#### Jobs Routes (`/api/jobs/*`)
- `POST /api/jobs/enqueue` - Enqueue background job
- **Body limit**: `32 KB` on `POST /api/jobs/enqueue`

### Unaffected Routes
All GET, HEAD, and OPTIONS endpoints continue to work without content-type restrictions.

## API Behavior

### Successful Requests

#### Valid JSON Request
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "name": "Test User"
  }'
```

**Response**: `200` or `201` (depending on endpoint)

#### Valid JSON with Charset
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json; charset=utf-8" \
  -d '{
    "email": "user@example.com", 
    "password": "password123"
  }'
```

**Response**: `200`

### Error Responses

#### Missing Content-Type Header
```bash
curl -X POST http://localhost:3000/api/auth/register \
  -d '{"email": "user@example.com"}'
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Content-Type must be application/json"
}
```

#### Invalid Content-Type
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: text/plain" \
  -d "email=user@example.com&password=password123"
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Content-Type must be application/json"
}
```

#### Invalid Charset
```bash
curl -X POST http://localhost:3000/api/auth/refresh \
  -H "Content-Type: application/json; charset=iso-8859-1" \
  -d '{"refreshToken": "token123"}'
```

**Response**: `415 Unsupported Media Type`
```json
{
  "error": "Unsupported Media Type: Only UTF-8 charset is supported for JSON"
}
```

#### Malformed JSON
```bash
curl -X POST http://localhost:3000/api/auth/logout \
  -H "Content-Type: application/json" \
  -d '{"refreshToken": invalid}'
```

**Response**: `400 Bad Request`
```json
{
  "error": "Unexpected token i in JSON at position 18"
}
```

## Testing

### Test Coverage
The implementation includes focused coverage in `src/tests/bodyLimit.test.ts` for JSON parser limits and per-route caps:

- **Global parser coverage**: Confirms the shared `500 KB` parser limit still returns `413`
- **Auth limit coverage**: Confirms `8 KB` auth bodies are accepted or rejected correctly
- **Jobs limit coverage**: Confirms `32 KB` job-enqueue bodies are accepted or rejected correctly
- **Error envelope coverage**: Confirms `PAYLOAD_TOO_LARGE` responses use the standardized error shape

### Running Tests
```bash
# Run body-limit specific tests
npm test -- src/tests/bodyLimit.test.ts

# Run all tests
npm test
```

### Test Matrix

| Method | Content-Type | Body | Expected Status |
|--------|-------------|------|----------------|
| GET | any | any | 200 (passes through) |
| POST | application/json | valid | 200/201 |
| POST | application/json; charset=utf-8 | valid | 200/201 |
| POST | missing | any | 415 |
| POST | text/plain | any | 415 |
| POST | application/x-www-form-urlencoded | any | 415 |
| POST | application/json | malformed | 400 |
| POST | application/json; charset=iso-8859-1 | any | 415 |
| POST `/api/auth/*` | application/json | body > 8 KB | 413 |
| POST `/api/jobs/enqueue` | application/json | body > 32 KB | 413 |

## Security Considerations

### Prevention of Bypass Attempts
The middleware prevents common bypass techniques:
- **Content-Type Spoofing**: Validates actual header content
- **Charset Manipulation**: Only allows UTF-8
- **Parameter Pollution**: Handles multiple content-type parameters
- **Case Sensitivity**: Case-insensitive header matching

### Request Body Detection
Middleware intelligently detects request bodies:
- **Content-Length Header**: Checks for positive content length
- **Empty Bodies**: Allows requests without bodies (Content-Length: 0)
- **Method-Based Logic**: GET/HEAD/OPTIONS bypass content-type checks
- **Route Caps**: Compares declared `Content-Length` to the configured `maxBytes` cap before route handlers run

## Migration Guide

### For API Consumers
1. **Update Clients**: Ensure all POST/PUT/PATCH/DELETE requests include `Content-Type: application/json`
2. **Error Handling**: Update error handling to expect `415` status codes
3. **Charset**: Ensure JSON payloads use UTF-8 encoding

### For Developers
1. **New Endpoints**: Apply `requireJson` middleware to new endpoints with request bodies
2. **Right-size limits**: Add a route-specific `express.json({ limit })` parser and matching `requireJson({ maxBytes })` guard for endpoints that need tighter caps than the global parser
3. **Testing**: Include body-limit and content-type validation tests for new endpoints
4. **Documentation**: Update API documentation to reflect content-type requirements and body-size limits

## Performance Impact

### Minimal Overhead
- **Header Validation**: Simple string comparison operations
- **Early Exit**: Failed requests terminate before reaching business logic
- **Memory Usage**: No additional memory allocation for validation

### Request Flow
1. **Content-Type Check**: Immediate validation or rejection
2. **Body Processing**: Only proceeds for valid content types
3. **Business Logic**: Standard request handling continues

## Troubleshooting

### Common Issues

#### 415 Errors on Valid Requests
- **Check Headers**: Ensure `Content-Type: application/json` is set
- **Verify Charset**: Use UTF-8 charset if specified
- **Case Sensitivity**: Headers are case-insensitive but value matching is exact

#### Integration Issues
- **Middleware Order**: Ensure `requireJson` is placed before body parsing middleware
- **Express Setup**: Verify `express.json()` middleware is properly configured

### Debug Mode
Enable debug logging to trace middleware execution:
```bash
DEBUG=content-type:* npm run dev
```

## Future Enhancements

### Planned Features
1. **Custom Content Types**: Support for API-specific JSON variants
2. **Rate Limiting Integration**: Enhanced protection for content-type violations
3. **CORS Integration**: Better handling of preflight requests
4. **Metrics Collection**: Track content-type violation attempts

### Extension Points
The middleware is designed for extensibility:
- **Custom Validators**: Easy to add additional content-type validation
- **Method-Specific Rules**: Fine-grained control per HTTP method
- **Error Customization**: Configurable error messages and formats

## Compliance

### Standards Compliance
- **RFC 7231**: Proper HTTP content-type handling
- **RFC 8259**: JSON media type specification compliance
- **Security Best Practices**: Defense against content-type injection attacks

### Audit Checklist
- [x] Content-Type header validation
- [x] Charset validation (UTF-8 only)
- [x] Consistent error responses
- [x] Comprehensive test coverage
- [x] Security bypass prevention
- [x] Performance optimization
- [x] Documentation completeness
