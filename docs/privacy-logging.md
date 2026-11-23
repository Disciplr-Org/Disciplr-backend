# Privacy Logging

## Overview

`src/middleware/privacy-logger.ts` implements privacy-hardened HTTP request logging. It:

- Recursively redacts all PII from request bodies, query strings, and headers before emitting any log output.
- Emits **exactly one structured JSON line per request** to `stdout` via `console.log`, on response finish.
- Exports a standalone `redact()` utility that any module can call.
- Never mutates the original request object.

## Log Schema

Every log line has exactly these top-level keys — no more, no less.

## Redaction Policy

### Export Queue DLQ and Metrics Events
Export job failure records and export queue structured events pass through the shared privacy sanitizer before they are persisted or emitted.
The sanitizer replaces `userId`, `targetUserId`, Stellar account addresses, emails, `creator`, `successDestination`, and `failureDestination` with deterministic 8-character SHA-256 tokens.
This keeps failed-job diagnostics and metrics correlation stable without exposing raw user identifiers to DLQ storage, logs, or downstream observability tooling.

### Allowlist Mode (Fail Closed)
The privacy logger runs in **allowlist mode** by default for request bodies, queries, and headers. This means **any field not explicitly allowlisted** is automatically redacted. This "fail closed" approach guarantees that newly added secrets (like webhook signing secrets, new API-key material, WebAuthn challenges, or JWTs) will never leak into the logs, even if they aren't manually added to the denylist.

Safe operational fields (e.g. `requestId`, `status`, `method`, `host`, `user-agent`) are allowlisted and pass through. The explicit denylist continues to apply and takes precedence (i.e. a field on the denylist is always redacted).

### Automatic Redaction Paths
The following paths are automatically redacted by Pino (value replaced with `***REDACTED***`):

#### Request Fields
- `req.headers.authorization` — Bearer tokens, API keys in Authorization header
- `req.headers.cookie` — Session cookies
- `req.headers["x-api-key"]` — Custom API key headers
- `req.body.password` — User passwords
- `req.body.token` — Auth tokens in body
- `req.body.accessToken` — OAuth access tokens
- `req.body.refreshToken` — OAuth refresh tokens
- `req.body.apiKey` — API keys in body
- `req.body.api_key` — Alternate API key format
- `req.body.secret` — Generic secrets
- `req.body.clientSecret` — OAuth client secrets
- `req.body.creator` — Vault creator addresses
- `req.body.successDestination` — Vault success destination addresses
- `req.body.failureDestination` — Vault failure destination addresses
- `req.body.email` — User email addresses

#### Response Fields
- `res.headers.authorization` — Bearer tokens in responses
- `res.headers.cookie` — Response cookies
- `res.headers["x-api-key"]` — API key headers in responses

#### Error Fields
- `err.authorization`, `err.password`, `err.token`, `err.apiKey`, `err.secret`

#### Metadata Fields
- All `metadata.*` sensitive fields (authorization, password, token, etc.)

#### Entity Fields
- `user.email`, `user.password`, `user.apiKey`
- `vault.creator`, `vault.successDestination`, `vault.failureDestination`

### Supported Data Structures
The redaction engine is recursive and works safely across:
- **Nested objects** — Redacts fields at any depth
- **Arrays** — Redacts sensitive fields in array elements
- **Standard objects** — Date, RegExp, Buffer objects are safely serialized
- **Circular references** — Protected against stack overflow

## Middleware Components

### Request Logger (`src/middleware/requestLogger.ts`)
Emits structured JSON for every HTTP request:

```json
{
  "timestamp": "2024-06-18T22:00:00.000Z",
  "level": "info",
  "event": "http.request",
  "service": "disciplr-backend",
  "method": "POST",
  "url": "/api/auth/login",
  "status": 200,
  "durationMs": 45,
  "ip": "10.20.x.x",
  "body": { "email": "[REDACTED]", "amount": 100 },
  "query": null,
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

### `redact<T>(value: T, seen = new WeakSet(), allowlistMode = false): T`

Deep-copies `value` and replaces every sensitive field value and every string matching a PII pattern with `REDACTED`. Input is never mutated. Handles circular references, `Date`, `RegExp`, `Buffer`, nested objects, and arrays.
If `allowlistMode` is `true`, any object field not present in the allowlist is also redacted.

```typescript
redact({ password: 'secret', amount: 100 })
// => { password: '[REDACTED]', amount: 100 }

redact({ unknownField: 'val', requestId: '123' }, undefined, true)
// => { unknownField: '[REDACTED]', requestId: '123' }

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
app.use(privacyLogger)
app.use('/api', router)
```

## Error Path

If log serialization fails for any reason, a minimal safe fallback is emitted and `next()` is still called:

```json
{ "level": "error", "event": "privacy-logger.serialization-failure", "timestamp": "..." }
```

No request data is included in the fallback.

## Privacy Endpoint Security

The `GET /api/privacy/export` and `DELETE /api/privacy/account` endpoints implement:

- **Strict rate limiting** via `strictRateLimiter` (10 req/hour, configured in `src/middleware/rateLimiter.ts`)
- **Creator ownership verification** — only the matching user or an admin may access/delete
- **Enumeration-resistant responses** — generic 404 for both non-owned and non-existent creators
- **Abuse monitoring** via `AbuseMonitor` (`src/services/abuse-monitor.ts`) — suspicious creator enumeration is recorded with `enumeration` category
- **Audit logging** on erasure via `src/lib/audit-logs.ts` (action: `privacy.account_erasure`)
- **Security metrics** surfaced through `GET /api/health/security` and `GET /api/admin/abuse/category-counts`

## Development vs Production

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

npm test -- src/tests/privacy-logger.test.ts
npm test -- src/tests/exportQueue.pii.test.ts
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

Coverage includes:
- ✅ Sensitive field redaction at all nesting levels
- ✅ IP masking (IPv4 and IPv6)
- ✅ Circular reference protection
- ✅ Date, RegExp, Buffer serialization
- ✅ Pino JSON structure verification
- ✅ PII leakage regression tests

### Property-Based Invariants

`src/tests/privacy-logger.test.ts` also uses `fast-check` with at least 100
generated cases per property to enforce:

- Sensitive keys are redacted at every nesting depth.
- Safe objects without sensitive keys or PII-pattern values remain deep-equal.
- `redact()` never mutates its input.
- Email-shaped and JWT-shaped values are redacted regardless of key name.
- Array elements are recursively redacted into a new array.
- Structured privacy log events contain only the documented key set.
- IPv4 masks keep the first two octets; IPv6 masks keep the first three groups.

## Compliance

This logging architecture supports compliance with:
- **GDPR** — Redaction prevents PII leakage to log storage; right to access and erasure endpoints are rate-limited and ownership-gated
- **HIPAA** — Sensitive fields are never stored in unencrypted logs
- **SOC 2** — Structured logging enables audit trail generation
- **PCI DSS** — Passwords, tokens, and API keys are redacted