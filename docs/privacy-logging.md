# Privacy Logging

## Overview

`src/middleware/privacy-logger.ts` implements privacy-hardened HTTP request logging. It:

- Recursively redacts all PII from request bodies, query strings, and headers before emitting any log output.
- Emits **exactly one structured JSON line per request** to `stdout` via `console.log`, on response finish.
- Exports a standalone `redact()` utility that any module can call.
- Never mutates the original request object.

## Log Schema

Every log line has exactly these top-level keys — no more, no less.

```jsonc
{
  "timestamp": "2024-06-18T22:00:00.000Z",   // ISO 8601 UTC
  "level": "info",                             // always "info"
  "event": "http.request",                    // always "http.request"
  "service": "disciplr-backend",              // always "disciplr-backend"
  "method": "POST",
  "url": "/api/auth/login",
  "status": 200,                              // HTTP response status code
  "durationMs": 45,                           // integer ms from req start to res finish
  "ip": "10.20.x.x",                         // masked (see IP Masking below)
  "body": { "email": "[REDACTED]", "amount": 100 }, // null if no body
  "query": null,                              // null if query string is empty
  "headers": { "content-type": "application/json", "authorization": "[REDACTED]" }
}
```

The schema is snapshot-tested in `src/tests/privacy-logger.redaction.test.ts`.

## Redaction Marker

Sensitive values are replaced with the string `"[REDACTED]"` (exported as `REDACTED`).

## What Gets Redacted

### Sensitive Field Names (case-insensitive key match)

| Key | Why |
|-----|-----|
| `password`, `passwordHash` | Credentials |
| `token`, `accessToken`, `refreshToken` | Auth tokens |
| `apiKey`, `api_key` | API keys |
| `secret`, `credential`, `credentials` | Generic secrets |
| `authorization` | Auth header |
| `x-api-key`, `x-auth-token` | Custom auth headers |
| `cookie` | Session cookies |
| `ssn` | Social Security Number |
| `creditCard`, `credit_card`, `cvv`, `pin` | Payment data |
| `email` | Email address |
| `clientSecret` | OAuth secret |
| `creator`, `successDestination`, `failureDestination` | Vault addresses |

### PII Patterns (applied to string values regardless of key name)

| Pattern | Example |
|---------|---------|
| Email address (`/[^@\s]+@[^@\s]+\.[^@\s]+/`) | `user@example.com` |
| JWT (`/^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/`) | `eyJ...` |

## IP Masking

| Input | Output |
|-------|--------|
| `192.168.1.1` (IPv4) | `192.168.x.x` |
| `2001:0db8:85a3::7334` (IPv6) | `2001:0db8:85a3:xxxx:xxxx:xxxx:xxxx:xxxx` |
| empty / unparseable | `unknown` |

## Exports

```typescript
import { redact, maskIp, shouldRedact, privacyLogger, REDACTED } from './middleware/privacy-logger.js'
```

### `redact<T>(value: T): T`

Deep-copies `value` and replaces every sensitive field value and every string matching a PII pattern with `REDACTED`. Input is never mutated. Handles circular references, `Date`, `RegExp`, `Buffer`, nested objects, and arrays.

```typescript
redact({ password: 'secret', amount: 100 })
// => { password: '[REDACTED]', amount: 100 }

redact({ nested: { email: 'a@b.com' } })
// => { nested: { email: '[REDACTED]' } }
```

### `maskIp(ip: string): string`

Returns a partially masked IP string (see table above).

### `shouldRedact(key: string): boolean`

Returns `true` if the key name (case-insensitive) is in the sensitive-field list.

### `privacyLogger`

Express middleware. Register it after body parsers and before routes:

```typescript
app.use(express.json())
app.use(privacyLogger)   // already registered in src/app.ts
app.use('/api', router)
```

## Error Path

If log serialization fails for any reason, a minimal safe fallback is emitted and `next()` is still called:

```json
{ "level": "error", "event": "privacy-logger.serialization-failure", "timestamp": "..." }
```

No request data is included in the fallback.

## Adding New Sensitive Fields

Edit `SENSITIVE_KEYS` in `src/middleware/privacy-logger.ts`:

```typescript
const SENSITIVE_KEYS = new Set([
  // ... existing keys ...
  'myNewSensitiveField',
])
```

Update the snapshot after changing the set:

```bash
npx jest src/tests/privacy-logger.redaction.test.ts --updateSnapshot
```

## Testing

```bash
# Run the hardened redaction test suite
npx jest src/tests/privacy-logger.redaction.test.ts

# Update snapshot after intentional schema changes
npx jest src/tests/privacy-logger.redaction.test.ts --updateSnapshot
```

Test coverage includes:

- Primitive passthrough
- Email and JWT value-pattern redaction
- All sensitive key names (case-insensitive)
- Nested object and array redaction
- Deeply nested PII
- Circular reference protection
- No input mutation
- `Date`, `RegExp`, `Buffer` serialization
- `maskIp` IPv4 / IPv6 / unknown
- Middleware schema (exact top-level keys)
- `null` body and `null` query
- Header redaction (`authorization`, `x-api-key`, `x-auth-token`, `cookie`)
- Serialization-failure fallback
- Snapshot of a representative request
