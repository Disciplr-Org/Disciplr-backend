# API Keys

This backend supports scoped API keys for server-to-server access. Keys are intended for least-privilege integrations such as analytics readers and must be presented in the `x-api-key` header.

## Security model

- API keys are never stored in plaintext.
- Clients receive the full key value only at create time and rotate time.
- Stored records keep only a SHA-256 hash of the secret plus metadata.
- Revocation is soft-state through `revoked_at`, so revoked keys remain auditable.
- If both `x-api-key` and user auth headers are present, `x-api-key` takes precedence on API-key protected routes. An invalid API key is rejected even if a bearer token is also present.

## Endpoints

### Create

`POST /api/api-keys`

Creates a new API key for the authenticated user.

Example:

```bash
curl -X POST "http://localhost:3000/api/api-keys" \
  -H "Content-Type: application/json" \
  -H "x-user-id: user-123" \
  -d '{
    "label": "analytics integration",
    "scopes": ["read:analytics", "read:vaults"]
  }'
```

Response notes:

- `apiKey` is returned exactly once.
- `apiKeyMeta` is safe to store or display because it omits the secret and hash.

### List

`GET /api/api-keys`

Lists API keys for the authenticated user. The response is redacted and never includes plaintext keys or hashes.

```bash
curl "http://localhost:3000/api/api-keys" \
  -H "x-user-id: user-123"
```

### Rotate

`POST /api/api-keys/:id/rotate`

Replaces the key secret while keeping the same key id and metadata.

```bash
curl -X POST "http://localhost:3000/api/api-keys/<api-key-id>/rotate" \
  -H "x-user-id: user-123"
```

After rotation:

- the old key stops working immediately
- the new plaintext value is returned once
- scopes and ownership stay the same

### Revoke

`POST /api/api-keys/:id/revoke`

Marks the key as revoked so further use is rejected.

```bash
curl -X POST "http://localhost:3000/api/api-keys/<api-key-id>/revoke" \
  -H "x-user-id: user-123"
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

## Rate limiting and logging

- API key management endpoints use the API key rate limiter.
- General request limiters key on `x-api-key` when present, so API-key traffic is throttled the same way as user-auth traffic.
- Rate-limit breach logs redact API key values.
- Request privacy logging masks sensitive body fields and should not emit plaintext API keys.
