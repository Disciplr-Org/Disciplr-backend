# API Keys

This backend supports scoped API keys for server-to-server access. Keys are intended for least-privilege integrations such as analytics readers and must be presented in the `x-api-key` header.

## Security model

- API keys are never stored in plaintext.
- Clients receive the full key value only at create time and rotate time.
- Stored records keep only a SHA-256 hash of the secret plus metadata.
- Revocation is soft-state through `revoked_at`, so revoked keys remain auditable.
- If both `x-api-key` and user auth headers are present, `x-api-key` takes precedence on API-key protected routes. An invalid API key is rejected even if a bearer token is also present.
- **Constant-time comparison:** All secret-material comparisons (both the SHA-256 fingerprint pre-check and the argon2id verification path) use `crypto.timingSafeEqual` from Node.js. Plain string equality (`===`) is never used on key material, preventing timing side-channel attacks.
- **Uniform failure:** Malformed, unknown, and revoked keys all return `{ valid: false, reason: '...' }` from `validateApiKey`; no different code path or exception leaks distinguishing information to the caller.

## Endpoints

### Create

`POST /api/api-keys`

Creates a new API key for the authenticated user.

Request body fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `label` | string | yes | Human-readable name, 1–100 characters. |
| `scopes` | string[] | yes | One or more valid scope strings. |
| `orgId` | UUID string | no | Bind the key to an organization the caller belongs to. |
| `expiresAt` | ISO 8601 string | no | Key expiry time. Must be a future UTC timestamp, at most 1 year from now. |

Example:

```bash
curl -X POST "http://localhost:3000/api/api-keys" \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -d '{
    "label": "analytics integration",
    "scopes": ["read:analytics", "read:vaults"],
    "expiresAt": "2027-01-01T00:00:00Z"
  }'
```

Response notes:

- `apiKey` is returned exactly once.
- `apiKeyMeta` is safe to store or display because it omits the secret and hash.
- `apiKeyMeta.expiresAt` is `null` when no expiry was set; otherwise an ISO 8601 UTC string.

## Key expiry

Pass an `expiresAt` ISO 8601 timestamp at creation time to set a hard expiry on a key. Once that time is reached:

- `validateApiKey` returns `{ valid: false, reason: 'expired' }`.
- Requests to API-key protected endpoints return `401` with `{ "error": "API key is expired." }`.
- Expiry is checked **before** scope authorization, so an expired key with correct scopes still fails.

Constraints:

- `expiresAt` must be a future timestamp.
- Maximum allowed value is 1 year from the time of creation.
- Omitting `expiresAt` creates a key with no expiry (existing behaviour).

### List

`GET /api/api-keys`

Lists API keys for the authenticated user. The response is redacted and never includes plaintext keys or hashes.

```bash
curl "http://localhost:3000/api/api-keys" \
  -H "x-user-id: user-123"
```

### Rotate

`POST /api/api-keys/:id/rotate`

Replaces the key secret while keeping the same key id and metadata. Supports an optional grace window for zero-downtime secret rollover.

```bash
curl -X POST "http://localhost:3000/api/api-keys/<api-key-id>/rotate" \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -d '{
    "graceSeconds": 300
  }'
```

Request options:

- `graceSeconds` (optional, integer 0–3600, default: 300): Duration in seconds during which the previous key remains valid. Set to `0` to invalidate the old key immediately.

After rotation:

- the new plaintext value is returned once in `apiKey`
- during the grace window, both the new key and the previous key are accepted; requests authenticated via the previous key include `usingPreviousSecret: true` in validation
- once the grace window expires (or if the key is revoked), the previous key secret is rejected
- background jobs periodically purge expired previous secrets
- scopes and ownership stay the same

### Revoke

`POST /api/api-keys/:id/revoke`

Marks the key as revoked so further use is rejected.

```bash
curl -X POST "http://localhost:3000/api/api-keys/<api-key-id>/revoke" \
  -H "x-user-id: user-123"
```

### Usage Analytics

`GET /api/orgs/:id/api-keys/usage`

Retrieves per-key usage analytics (last-used timestamp, total request counter, and last-seen IP) for all keys under the organization. Restricted to organization owners and admins. Never exposes secrets or hashes.

```bash
curl "http://localhost:3000/api/orgs/org-123/api-keys/usage" \
  -H "x-user-id: user-123"
```

Response:
```json
{
  "usage": [
    {
      "id": "a1b2c3d4...",
      "label": "read-only analytics key",
      "scopes": ["read:analytics"],
      "createdAt": "2026-06-28T12:00:00.000Z",
      "revokedAt": null,
      "lastUsedAt": "2026-06-28T18:25:00.000Z",
      "requestCount": 42,
      "lastIp": "192.168.1.10"
    }
  ]
}
```

## Using a key

Use the issued secret in the `x-api-key` header on API-key protected endpoints.

```bash
curl "http://localhost:3000/api/analytics/overview" \
  -H "x-api-key: dsk_<id>.<secret>"
```

Least-privilege examples:

- `read:analytics` for analytics overview and trend endpoints
- `read:vaults` for vault analytics views

Valid scope values are typed and strictly validated at key creation. Unknown or misspelled
scope strings (for example `vault.crete`) are rejected with a `VALIDATION_ERROR`.

Supported scopes:

- `read:analytics`
- `read:vaults`

## Rate limiting and logging

- API key management endpoints use the API key rate limiter.
- General request limiters key on `x-api-key` when present, so API-key traffic is throttled the same way as user-auth traffic.
- Rate-limit breach logs redact API key values.
- Request privacy logging masks sensitive body fields and should not emit plaintext API keys.
