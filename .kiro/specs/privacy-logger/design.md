# Design Document: privacy-logger

## Overview

The `privacy-logger` middleware replaces the current ad-hoc `console.log` implementation in `src/middleware/privacy-logger.ts` with a hardened, structured-logging middleware. It exports two things:

1. `redact(value)` — a pure, recursive utility that deep-copies any value and replaces all sensitive field names and PII-pattern values with `"[REDACTED]"`.
2. `privacyLogger` — an Express middleware that logs one structured JSON line per request (on `res.finish`) with all request data passed through `redact`.

The existing `sanitizeBody` and `maskIp` helpers are replaced/extended. The `requestLogger` middleware in `requestLogger.ts` is superseded by `privacyLogger` for structured output; `requestLogger` can remain for plain-text dev output if desired but `privacyLogger` is the authoritative structured logger registered in `app.ts`.

## Architecture

```
app.ts
  └── app.use(privacyLogger)          ← registered early, before routes
        ├── res.on('finish', handler) ← captures status + duration
        └── handler
              ├── maskIp(req.ip)
              ├── redact(req.body)
              ├── redact(req.query)
              ├── redact(req.headers)
              └── console.log(JSON.stringify(logLine))
```

`redact` is a standalone pure function with no Express dependency, making it independently testable and reusable across the codebase.

## Components and Interfaces

### `redact<T>(value: T): T`

```typescript
export function redact<T>(value: T): T
```

- Accepts any value; returns the same type.
- For primitives (string, number, boolean, null, undefined): returns as-is, **unless** the value is a string matching an email or JWT pattern, in which case returns `"[REDACTED]"` (cast to `T`).
- For arrays: returns a new array with each element recursively redacted.
- For plain objects: returns a new object where:
  - Keys matching `SENSITIVE_KEYS` (case-insensitive) have their value replaced with `"[REDACTED]"`.
  - All other keys have their value recursively redacted (catches nested PII patterns).
- Handles circular references by catching errors and substituting `"[REDACTED]"`.

### `SENSITIVE_KEYS: Set<string>`

Lowercase set used for O(1) key lookup:

```
password, passwordhash, token, accesstoken, refreshtoken,
apikey, api_key, secret, authorization, x-api-key,
x-auth-token, credential, credentials, ssn,
creditcard, credit_card, cvv, pin, cookie
```

### `PII_PATTERNS: RegExp[]`

```typescript
const EMAIL_RE = /[^@\s]+@[^@\s]+\.[^@\s]+/
const JWT_RE   = /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/
```

### `maskIp(ip: string): string`

Unchanged contract from existing implementation; moved to a named export for testability.

- IPv4 `a.b.c.d` → `a.b.x.x`
- IPv6 → first three groups + `:xxxx:xxxx:xxxx:xxxx:xxxx`
- Fallback → `"unknown"`

### `privacyLogger` middleware

Registers a `res.on('finish')` listener, then calls `next()`. On finish:

```typescript
interface LogLine {
  timestamp: string   // utcNow()
  level: 'info'
  event: 'http.request'
  service: 'disciplr-backend'
  method: string
  url: string
  status: number
  durationMs: number
  ip: string
  body: Record<string, unknown> | null
  query: Record<string, unknown> | null
  headers: Record<string, unknown>
}
```

Wraps `JSON.stringify` in a try/catch; on failure emits:

```json
{ "level": "error", "event": "privacy-logger.serialization-failure", "timestamp": "<ISO>" }
```

## Data Models

### `LogLine` (TypeScript interface, not persisted)

| Field       | Type                              | Notes                              |
|-------------|-----------------------------------|------------------------------------|
| timestamp   | string                            | ISO 8601 UTC from `utcNow()`       |
| level       | `"info"`                          | Always `"info"` for normal requests|
| event       | `"http.request"`                  | Fixed discriminator                |
| service     | `"disciplr-backend"`              | Fixed service name                 |
| method      | string                            | `req.method`                       |
| url         | string                            | `req.originalUrl`                  |
| status      | number                            | `res.statusCode`                   |
| durationMs  | number                            | Integer ms                         |
| ip          | string                            | Masked via `maskIp`                |
| body        | `Record<string,unknown>` \| null  | `null` if no body                  |
| query       | `Record<string,unknown>` \| null  | `null` if empty                    |
| headers     | `Record<string,unknown>`          | Always present, redacted           |

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

---

Property 1: Sensitive keys are always redacted (including nested)
*For any* object of arbitrary depth that contains one or more keys from `SENSITIVE_KEYS`, calling `redact()` on it should produce an output where every sensitive key's value equals `"[REDACTED]"` at every nesting level.
**Validates: Requirements 1.1, 1.2**

---

Property 2: Non-sensitive fields are preserved
*For any* object containing only non-sensitive keys and no PII-pattern values, `redact()` should return a deep-equal copy with all values unchanged.
**Validates: Requirements 1.5**

---

Property 3: Immutability — redact does not mutate its input
*For any* object passed to `redact()`, the original object should be identical (deep-equal) before and after the call.
**Validates: Requirements 1.6**

---

Property 4: Email-pattern values are redacted regardless of key name
*For any* object where a field value is a string matching the email regex, `redact()` should replace that value with `"[REDACTED]"` regardless of what the key is named.
**Validates: Requirements 1.3**

---

Property 5: JWT-pattern values are redacted regardless of key name
*For any* object where a field value is a string matching the JWT regex, `redact()` should replace that value with `"[REDACTED]"` regardless of what the key is named.
**Validates: Requirements 1.4**

---

Property 6: Array elements are recursively redacted
*For any* array containing objects with sensitive keys or PII-pattern values, `redact()` should return a new array where every element has been recursively redacted.
**Validates: Requirements 5.3**

---

Property 7: Log line has exactly the required top-level keys
*For any* HTTP request (varying method, URL, body, headers, status code), the JSON object emitted by `privacyLogger` should have exactly the keys: `timestamp`, `level`, `event`, `service`, `method`, `url`, `status`, `durationMs`, `ip`, `body`, `query`, `headers` — no more, no fewer.
**Validates: Requirements 2.2, 2.3**

---

Property 8: IP masking produces a masked form for any valid IP
*For any* valid IPv4 address, `maskIp` should return a string matching `^\\d+\\.\\d+\\.x\\.x$`. *For any* valid IPv6 address, `maskIp` should return a string with exactly three real groups followed by five `xxxx` groups.
**Validates: Requirements 3.1, 3.2**

---

Property 9: next() is always called
*For any* request (including requests with malformed bodies, circular references, or missing fields), `privacyLogger` should always invoke `next()` exactly once.
**Validates: Requirements 7.3**

## Error Handling

| Scenario | Behaviour |
|---|---|
| `JSON.stringify` throws (e.g. circular ref in log object) | Catch, emit minimal fallback JSON, call `next()` |
| `redact` receives circular reference in input | Catch per-value, substitute `"[REDACTED]"`, continue |
| `req.ip` is undefined | `maskIp` returns `"unknown"` |
| `req.body` is not a plain object | `body` field set to `null` |
| `req.query` is empty object `{}` | `query` field set to `null` |

## Testing Strategy

### Dual Testing Approach

Both unit tests and property-based tests are required and complementary.

- **Unit tests** cover specific examples, snapshot assertions, and edge cases (empty body, missing IP, circular refs, fallback log line).
- **Property-based tests** verify universal correctness across randomly generated inputs.

### Property-Based Testing

Use **[fast-check](https://github.com/dubzzz/fast-check)** (`npm install --save-dev fast-check`), which integrates cleanly with Jest.

Each property test runs a minimum of **100 iterations**.

Tag format for each test: `// Feature: privacy-logger, Property N: <property text>`

| Property | Test description |
|---|---|
| P1 | Generate random nested objects with sensitive keys; assert all are `"[REDACTED]"` in output |
| P2 | Generate random safe objects; assert `redact(obj)` deep-equals `obj` |
| P3 | Generate random objects; assert original is unchanged after `redact(obj)` |
| P4 | Generate random objects with email-valued fields at arbitrary keys; assert all replaced |
| P5 | Generate random objects with JWT-valued fields at arbitrary keys; assert all replaced |
| P6 | Generate random arrays of objects with sensitive keys; assert all elements redacted |
| P7 | Generate random Express-like requests; assert log line key set is exactly the required set |
| P8 | Generate random IPv4/IPv6 strings; assert `maskIp` output matches expected pattern |
| P9 | Generate random requests including malformed ones; assert `next` spy called exactly once |

### Unit / Snapshot Tests

- Snapshot test: fire a mock request with `Authorization: Bearer <token>`, `x-api-key: <key>`, body `{ email, password }` — assert serialized log matches stored snapshot.
- Edge cases: no body, no query, unknown IP, circular body, serialization failure fallback.
- Test file: `tests/middleware/privacy-logger.test.ts` using Jest + `ts-jest`.
- Coverage target: ≥ 95% on `src/middleware/privacy-logger.ts`.
