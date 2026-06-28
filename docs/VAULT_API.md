# Vault API Documentation

## Overview

API endpoints for vault lifecycle management including creation, retrieval, cancellation, and user-specific vault queries.

## Authentication

All endpoints require:
- `Authorization: Bearer <jwt_token>` header

## Endpoints

### GET /api/vaults

List vaults with pagination, filtering, and sorting.

**Query Parameters:**
- `status`: Filter by status (active, completed, failed, cancelled)
- `creator`: Filter by creator address
- `sort`: Sort field (createdAt, amount, endTimestamp, status)
- `sortOrder`: asc or desc
- `page`: Page number
- `limit`: Results per page

**Response:**
```json
{
  "data": [
    {
      "id": "uuid",
      "creator": "G...",
      "amount": "1000.0000000",
      "status": "active",
      "startTimestamp": "2026-02-26T12:00:00Z",
      "endTimestamp": "2026-03-26T12:00:00Z",
      "successDestination": "G...",
      "failureDestination": "G...",
      "createdAt": "2026-02-26T12:00:00Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "offset": 0,
    "total": 100,
    "hasMore": true
  }
}
```

### POST /api/vaults

Create a new vault.

**Body:**
```json
{
  "creator": "GABC...",
  "amount": "1000.0000000",
  "endTimestamp": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "milestoneHash": "hash123",
  "verifierAddress": "G...",
  "contractId": "contract123"
}
```

**Response:** `201 Created`
```json
{
  "id": "uuid",
  "creator": "G...",
  "amount": "1000.0000000",
  "status": "active",
  "startTimestamp": "2026-02-26T12:00:00Z",
  "endTimestamp": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "createdAt": "2026-02-26T12:00:00Z"
}
```

### GET /api/vaults/:id

Get vault by ID. Tries database first, falls back to in-memory storage.

Supports HTTP conditional requests using ETags for efficient caching and polling.

**ETag and Conditional GET:**

This endpoint implements RFC 7232 weak ETags for cache validation:

- **ETag**: Weak ETag computed from the vault's version (optimistic-concurrency xmin)
- **If-None-Match**: Client sends previously received ETag; server responds with 304 if unchanged
- **Cache-Control**: Set to `private, max-age=0, must-revalidate` (revalidate on every request)

Example flow:
```bash
# First request - receives vault and ETag
curl -H "Authorization: Bearer <token>" \
  https://api.example.com/api/vaults/vault-123
# Response 200 with header: ETag: W/"-12345"

# Subsequent request with If-None-Match
curl -H "Authorization: Bearer <token>" \
  -H "If-None-Match: W\"-12345\"" \
  https://api.example.com/api/vaults/vault-123
# Response 304 Not Modified (no body, saves bandwidth)

# After vault update - ETag changes
curl -H "Authorization: Bearer <token>" \
  -H "If-None-Match: W\"-12345\"" \
  https://api.example.com/api/vaults/vault-123
# Response 200 with new vault data and new ETag: W/"-12346"
```

**Response (200 OK):**
```json
{
  "id": "uuid",
  "creator": "G...",
  "amount": "1000.0000000",
  "status": "active",
  "startDate": "2026-02-26T12:00:00Z",
  "endDate": "2026-03-26T12:00:00Z",
  "successDestination": "G...",
  "failureDestination": "G...",
  "createdAt": "2026-02-26T12:00:00Z"
}
```

**Response (304 Not Modified):**
- No response body
- ETag header included for validation
- Indicates client's copy is up-to-date

**Response Headers (200):**
- `ETag`: Weak ETag for this vault representation (format: `W/"-<version>"`)
- `Cache-Control`: `private, max-age=0, must-revalidate`

**Response Headers (304):**
- `ETag`: Same ETag that matched If-None-Match
- `Cache-Control`: `private, max-age=0, must-revalidate`

**Query Parameters:**
None (ETag caching is automatic)

**Client Implementation Notes:**

1. **Store ETag**: Cache the ETag from the `ETag` response header
2. **Conditional Request**: Use `If-None-Match: <stored-etag>` on subsequent requests
3. **Handle 304**: If server responds with 304, use your cached vault data (it's still current)
4. **Handle 200**: If server responds with 200, update your cache with new data and new ETag
5. **Polling**: Polling clients benefit significantly from reduced payload sizes on 304 responses

**JavaScript/TypeScript Example:**

```typescript
let cachedVault: any = null;
let cachedETag: string | null = null;

async function getVault(id: string) {
  const headers: HeadersInit = {
    'Authorization': `Bearer ${token}`,
  };

  // Add If-None-Match if we have a cached ETag
  if (cachedETag) {
    headers['If-None-Match'] = cachedETag;
  }

  const response = await fetch(`/api/vaults/${id}`, { headers });

  if (response.status === 304) {
    // Not Modified - use cached data
    console.log('Cache hit! Vault unchanged.');
    return cachedVault;
  }

  if (response.status === 200) {
    // Updated or first request
    cachedVault = await response.json();
    cachedETag = response.headers.get('ETag') || null;
    console.log('Fetched vault, ETag:', cachedETag);
    return cachedVault;
  }

  // Error handling
  throw new Error(`Failed to fetch vault: ${response.status}`);
}
```

### POST /api/vaults/:id/cancel

Cancel a vault. Only the creator or an admin can cancel.

**Body:**
```json
{
  "reason": "Optional cancellation reason"
}
```

**Response:** `200 OK`
```json
{
  "message": "Vault cancelled",
  "id": "uuid"
}
```

**Audit Logging:**
This endpoint creates an audit log entry with:
- Action: `vault.cancelled`
- Target: `vault:{vault_id}`
- Metadata:
  - `previous_status`: Vault status before cancellation
  - `new_status`: Always set to "cancelled"
  - `reason`: Cancellation reason (or default "User requested cancellation")
  - `cancelled_by`: "creator" or "admin"
  - `creator`: Original vault creator
  - `amount`: Vault amount

### GET /api/vaults/user/:address

Get all vaults for a specific user address.

**Response:**
```json
[
  {
    "id": "uuid",
    "creator": "G...",
    "amount": "1000.0000000",
    "status": "active",
    ...
  }
]
```

## HTTP Caching and ETags

The Vault API implements **weak ETags** (RFC 7232) for efficient caching and bandwidth optimization, especially beneficial for polling clients.

### Why ETags?

- **Bandwidth optimization**: Polling clients can check for changes without downloading the full vault payload
- **Cache validation**: Clients can verify if their cached data is still current
- **Conditional requests**: Server responds with 304 Not Modified, saving bandwidth

### How It Works

1. Client makes a request to `GET /api/vaults/:id`
2. Server includes an `ETag` header (weak ETag format: `W/"-<version>"`)
3. Client stores the ETag value
4. On next request, client sends `If-None-Match: <stored-etag>`
5. Server either:
   - Returns **304 Not Modified** if ETag still matches (no body, minimal overhead)
   - Returns **200 OK** with new vault data and new ETag if vault changed

### ETag Format

- **Weak ETag**: `W/"-<version>"`
- Derived from the vault's optimistic-concurrency version (PostgreSQL xmin)
- Updated whenever the vault is modified
- Used for semantic caching (appropriate for JSON representations)

### Bandwidth Savings Example

Without ETags (polling every 30s for 1 hour):
- 120 requests × ~500 bytes per vault = **~60 KB**

With ETags (120 requests, 95% hit rate):
- 120 requests × ~50 bytes per 304 response + 6 × ~500 bytes for 200 = **~3.5 KB**
- **~94% reduction** in bandwidth usage

### Implementation

**ETag Header:**
- Present in all 200 and 304 responses from `GET /api/vaults/:id`
- Format: `W/"-<version>"`
- Weak ETag indicates content may be transformed but semantically equivalent

**Cache-Control Header:**
- Set to `private, max-age=0, must-revalidate`
- Instructs clients to always revalidate before using cached copy
- Appropriate for vault data that may change frequently

**If-None-Match Header:**
- Optional header in client requests
- Contains previously received ETag(s)
- Supports multiple ETags: `If-None-Match: W/"-123", W/"-456"`

## Error Responses

```json
{"error": "Descriptive message"}
```

Status codes: 200, 201, 400, 401, 403, 404, 500

### Stellar address checksum validation

Fields that accept Stellar ed25519 public keys (addresses starting with "G")
are validated for both format and checksum at request time. Invalid addresses
will be rejected with a `400` validation error. Example response for an
invalid `verifier` value:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "invalid Stellar public key",
    "details": { "field": "verifier" }
  }
}
```

## Security

- JWT authentication required for all endpoints
- Authorization checks for vault cancellation (creator or admin only)
- Input validation for all parameters
- Idempotency support for vault creation

## Testing

Run tests: `npm run test:vaults`
