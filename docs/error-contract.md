# API Error Contract

This document defines the standardized error response envelope used across all Disciplr API routes.

## Error Response Format

All API errors return a consistent JSON envelope with the following structure:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error description",
    "details": {},
    "requestId": "req-abc-123"
  }
}
```

### Field Descriptions

| Field       | Type   | Required | Description                                                                             |
| ----------- | ------ | -------- | --------------------------------------------------------------------------------------- |
| `code`      | string | Yes      | Machine-readable error code for programmatic handling                                   |
| `message`   | string | Yes      | Human-readable error description                                                        |
| `details`   | object | No       | Additional context (e.g., validation field errors). Only present for validation errors. |
| `requestId` | string | No       | Echoed from `x-request-id` header for request correlation                               |

## Error Codes

The following stable error codes are used across the API:

### 400 Bad Request

- `BAD_REQUEST` - Generic bad request (malformed syntax, invalid parameters)
- `VALIDATION_ERROR` - Request validation failed (includes field-level details)

### 401 Unauthorized

- `UNAUTHORIZED` - Authentication required or failed

### 403 Forbidden

- `FORBIDDEN` - Authenticated but not authorized for this resource

### 404 Not Found

- `NOT_FOUND` - Resource does not exist

### 409 Conflict

- `CONFLICT` - Resource conflict (e.g., duplicate entry)

### 422 Unprocessable Entity

- `UNPROCESSABLE` - Business logic violation (e.g., cannot delete last admin)

### 429 Too Many Requests

- `RATE_LIMITED` - Rate limit exceeded

### 500 Internal Server Error

- `INTERNAL_ERROR` - Unexpected server error (safe message, no stack traces)

## Example Error Responses

### Validation Error (400)

Endpoints that reject request payloads after schema validation return HTTP `400` with this envelope:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "fields": [
      {
        "path": "email",
        "message": "Invalid email address",
        "code": "invalid_format"
      }
    ]
  }
}
```

Rules:

- `error.code` is always `VALIDATION_ERROR` for request validation failures.
- `error.message` is always `Invalid request payload`.
- `error.fields` is a flat array of client-friendly field issues.
- `path` uses dot notation for nested objects and bracket notation for arrays, for example `payload.subject` or `milestones[0].dueDate`.
- Root-level validation failures use `path: "root"`.
- `message` comes from the schema and should explain the problem without echoing secrets or entire payloads.
- `code` comes from the underlying validator issue code, such as `invalid_type`, `invalid_union`, `invalid_value`, `too_small`, or `custom`.

Examples:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "fields": [
      {
        "path": "amount",
        "message": "must be a positive number",
        "code": "custom"
      }
    ]
  }
}
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request payload",
    "fields": [
      {
        "path": "payload.subject",
        "message": "Invalid input: expected string, received undefined",
        "code": "invalid_type"
      }
    ]
  }
}
```

### Authentication Error (401)

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid credentials",
    "requestId": "req-def-456"
  }
}
```

### Not Found (404)

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "Route not found: GET /api/nonexistent",
    "requestId": "req-ghi-789"
  }
}
```

### Conflict (409)

```json
{
  "error": {
    "code": "CONFLICT",
    "message": "User already exists",
    "requestId": "req-jkl-012"
  }
}
```

### Internal Error (500)

```json
{
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Internal server error",
    "requestId": "req-mno-345"
  }
}
```

## Security Considerations

### PII and Internal Detail Sanitization

In production environments (`NODE_ENV=production`), all error responses are automatically sanitized to prevent the leakage of sensitive information. This includes:

- **Internal Error Details**: For `500 Internal Server Error` responses, the original error message and stack trace are logged internally but are **never** included in the JSON response body. The client receives a generic "Internal server error" message.
- **PII Redaction**: For validation errors (HTTP 400) that might echo back parts of the request payload in the `details` field, any values matching the PII taxonomy (e.g., email addresses, wallet addresses, sensitive keys) are automatically redacted.
- **Correlation ID**: The `requestId` is always preserved, allowing for secure error correlation between the client and server-side logs.

In non-production environments, error messages may contain more detail to aid in debugging.

1. **No Stack Traces**: Stack traces are never exposed in production error responses
2. **No Secrets**: Error messages never include tokens, API keys, database credentials, or raw SQL
3. **Safe Messages**: Internal errors return generic "Internal server error" messages to prevent information leakage

## Client Integration Guidelines

### Handling Errors

Clients should:

1. Check the HTTP status code first
2. Use the `code` field for programmatic error handling (not the message)
3. Display the `message` field to users
4. Include `x-request-id` header in support requests for traceability

### Example Client Code

```typescript
// TypeScript example
interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
}

async function apiCall(): Promise<void> {
  const response = await fetch("/api/resource", {
    headers: {
      "x-request-id": generateRequestId(), // For traceability
    },
  });

  if (!response.ok) {
    const error: ApiError = await response.json();

    // Handle by code, not message
    switch (error.error.code) {
      case "VALIDATION_ERROR":
        // Show field-level errors
        showValidationErrors(error.error.details);
        break;
      case "UNAUTHORIZED":
        // Redirect to login
        redirectToLogin();
        break;
      case "NOT_FOUND":
        // Show 404 page
        showNotFound();
        break;
      default:
        // Generic error display
        showError(error.error.message);
    }

    // Log requestId for support
    console.error("Request ID:", error.error.requestId);
  }
}
```

## Backend Usage

Route handlers use `AppError` factory methods for consistent errors:

```typescript
import { AppError } from "../middleware/errorHandler.js";

// Validation error with details
return next(AppError.validation("Invalid input", { field: "email" }));

// Simple bad request
return next(AppError.badRequest("Missing required field"));

// Authentication required
return next(AppError.unauthorized("Invalid token"));

// Permission denied
return next(AppError.forbidden("Admin access required"));

// Resource not found
return next(AppError.notFound("User not found"));

// Conflict
return next(AppError.conflict("Email already registered"));

// Business logic violation
return next(AppError.unprocessable("Cannot delete last admin"));

// Internal error (rarely used directly)
return next(AppError.internal());
```

## Testing

Error responses are thoroughly tested in `src/tests/errorHandler.test.ts` with >95% coverage for:

- All AppError factory methods
- Error envelope structure validation
- requestId echo behavior
- Secret leakage prevention
- All HTTP status codes
