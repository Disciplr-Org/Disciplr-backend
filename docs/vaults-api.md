# Vaults API Validation and Payload Contracts

This document describes the expected request shape for `POST /api/vaults` and the validation constraints enforced by the server.

## Request body

`POST /api/vaults`

- `amount`: string or number; must be a positive number between `1` and `1,000,000,000` inclusive.
  - Rejects: `0`, negative numbers, non-numeric strings, `Infinity`, `NaN`
  - Accepts: numeric values via preprocessing (e.g., `1000`)
- `startDate`: valid ISO timestamp string.
  - Rejects: invalid dates, malformed formats, non-string types
- `endDate`: valid ISO timestamp string; must be strictly after `startDate`.
  - Rejects: dates equal to or before `startDate`
- `verifier`: valid Stellar public key (`G` + 55 Base32 characters).
  - Format: `G[A-Z2-7]{55}`
  - Rejects: invalid characters, wrong length, wrong prefix, non-string types
- `destinations`: object containing:
  - `success`: valid Stellar public key.
  - `failure`: valid Stellar public key.
- `milestones`: array of milestone objects.
  - Minimum: `1` milestone.
  - Maximum: `20` milestones.
  - Total milestone amounts must not exceed vault amount.
- `creator` (optional): valid Stellar public key for the vault creator.
  - Format: Same as verifier field
  - Must be a valid Stellar address if provided
- `onChain` (optional): object containing blockchain deployment configuration.
  - `mode`: `'build'` (default) or `'submit'`
  - `contractId`: optional string identifier
  - `networkPassphrase`: optional string for network specification
  - `sourceAccount`: optional Stellar address for transaction source

### Milestone object

Each milestone must include:

- `title`: non-empty string (whitespace-only strings are rejected).
  - No explicit length limit (handled by payload size constraints)
- `dueDate`: valid ISO timestamp string that is not before `startDate`.
  - Can be equal to `startDate`
  - Must use UTC timezone format (e.g., `2030-01-01T00:00:00.000Z`)
  - Rejects offset timezones (e.g., `+05:00`)
- `amount`: string or number; must be a positive number within the same vault bounds.
  - Rejects decimal values (must be whole numbers)
  - Accepts integer values only

## Boundary Conditions and Edge Cases

### Amount Validation

- **Minimum**: `1` (inclusive)
- **Maximum**: `1,000,000,000` (inclusive)
- **Rejected values**: `0`, negative numbers, `Infinity`, `NaN`, non-numeric strings
- **Accepted preprocessing**: Numbers are converted to strings automatically

### Timestamp Validation

- **Format**: ISO 8601 with UTC timezone (e.g., `2030-01-01T00:00:00.000Z`)
  - Accepts: `2030-01-01T00:00:00Z` (no milliseconds)
  - Accepts: `2030-01-01T00:00:00.123Z` (with milliseconds)
  - Rejects: Offset timezones (`+05:00`, `-08:00`)
  - Rejects: Missing timezone
- **Date relationship**: `endDate` must be strictly greater than `startDate`
- **Milestone constraint**: `dueDate` must be greater than or equal to `startDate`
- **Edge case**: `endDate` can be exactly 1 millisecond after `startDate`
- **Range limits**: Must be within JavaScript's safe date range

### Stellar Address Validation

- **Pattern**: `G[A-Z2-7]{55}` (Stellar G-address format)
- **Invalid characters**: `0`, `1`, `8`, `9`, lowercase letters
- **Length**: Exactly 56 characters (including `G` prefix)
- **Prefix**: Must start with `G`

### Milestone Array Validation

- **Minimum length**: `1`
- **Maximum length**: `20`
- **Amount constraint**: Sum of all milestone amounts ≤ vault amount
- **Date constraint**: Each milestone `dueDate` ≥ `startDate`

## Error formatting

Validation failures are returned with status `400` and the standard error envelope:

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
      },
      {
        "path": "milestones[0].dueDate",
        "message": "must be a valid ISO timestamp",
        "code": "custom"
      }
    ]
  }
}
```

Field paths are stable and use bracket notation for arrays (for example: `milestones[1].dueDate`). Error messages are specific to each validation rule.

## Payload size limits

The server enforces a maximum JSON body size of `100kb` for all incoming requests. Requests above this threshold will return `413 Payload Too Large` with the following error envelope:

```json
{
  "error": {
    "code": "PAYLOAD_TOO_LARGE",
    "message": "Payload too large"
  }
}
```

## Security constraints

### Input Validation

- **Type safety**: All required fields reject `null`, `undefined`, and incorrect types
- **Format validation**: Stellar addresses are validated against strict regex patterns
  - Only accepts uppercase Base32 characters: `A-Z2-7`
  - Rejects: `0`, `1`, `8`, `9`, lowercase letters
- **Bounds checking**: All numeric inputs are validated against minimum/maximum constraints
- **Array limits**: Milestone arrays are capped to prevent DoS via large payloads
- **String length**: No explicit per-field limits, but overall payload size is constrained

### Overflow Protection

- **Integer bounds**: Amount values are checked against safe integer limits
  - Rejects values exceeding `Number.MAX_SAFE_INTEGER`
  - Rejects `Infinity` and `NaN`
- **Memory safety**: Large string values are handled gracefully without causing memory exhaustion
- **Nested structure limits**: Milestone array size is capped to prevent exponential complexity
- **Decimal protection**: Amount fields reject decimal values, enforcing integer-only inputs

### Error Information Disclosure

- **Consistent formatting**: Error messages don't leak internal implementation details
- **Path stability**: Field paths remain consistent across requests to prevent information leakage
- **Message specificity**: Error messages are descriptive but don't reveal system internals

## Test Coverage

The validation logic is covered by comprehensive tests including:

### Unit Tests (`src/services/vaultValidation.test.ts`)

- Boundary condition testing for all fields
- Invalid type validation
- Edge case handling (Infinity, NaN, overflow)
- Error formatting stability
- Security constraint validation
- Stellar address validation edge cases
- Timestamp validation with various formats
- Milestone array boundary conditions
- onChain field validation
- Creator field validation
- Complex multi-field error scenarios

### Integration Tests (`src/routes/vaults.test.ts`)

- HTTP-level validation testing
- Malformed payload handling
- Content-type validation
- JSON parsing error handling
- Payload size limit enforcement
- onChain configuration validation
- Creator address validation
- Multi-field validation error handling
- Large payload handling
- Decimal amount rejection

**Target coverage**: Minimum 95% for validation logic

## Examples

### Valid Request

```json
{
  "amount": "1000",
  "startDate": "2030-01-01T00:00:00.000Z",
  "endDate": "2030-06-01T00:00:00.000Z",
  "verifier": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "destinations": {
    "success": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "failure": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  },
  "milestones": [
    {
      "title": "Kickoff",
      "dueDate": "2030-02-01T00:00:00.000Z",
      "amount": "500"
    },
    {
      "title": "Completion",
      "dueDate": "2030-05-01T00:00:00.000Z",
      "amount": "500"
    }
  ]
}
```

### Invalid Request Examples

```json
// Amount too small
{
  "amount": "0",
  // ... other fields
}

// Invalid Stellar address
{
  "verifier": "invalid_address",
  // ... other fields
}

// End date before start date
{
  "startDate": "2030-06-01T00:00:00.000Z",
  "endDate": "2030-01-01T00:00:00.000Z",
  // ... other fields
}

// Milestone total exceeds vault amount
{
  "amount": "1000",
  "milestones": [
    { "title": "M1", "dueDate": "2030-02-01T00:00:00.000Z", "amount": "600" },
    { "title": "M2", "dueDate": "2030-03-01T00:00:00.000Z", "amount": "500" }
  ],
  // ... other fields
}

// Invalid onChain mode
{
  "onChain": {
    "mode": "invalid-mode"
  },
  // ... other fields
}

// Decimal amount (rejected)
{
  "amount": "1000",
  "milestones": [
    { "title": "M1", "dueDate": "2030-02-01T00:00:00.000Z", "amount": "100.50" }
  ],
  // ... other fields
}
```

---

## Org-Scoped Saved Vault Searches

Operators can persist a named query against an org's vault set and optionally subscribe to change notifications when the result set shifts.

### Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST`   | `/api/orgs/:orgId/vault-searches` | owner, admin | Create a saved search |
| `GET`    | `/api/orgs/:orgId/vault-searches` | owner, admin, member | List all saved searches |
| `GET`    | `/api/orgs/:orgId/vault-searches/:searchId` | owner, admin, member | Get one saved search |
| `DELETE` | `/api/orgs/:orgId/vault-searches/:searchId` | owner, admin | Delete a saved search |

### Request body — POST

```json
{
  "name": "Active high-value vaults",
  "query_definition": {
    "status": "active",
    "amount_min": "10000",
    "sort_by": "created_at",
    "sort_order": "desc",
    "limit": 50
  },
  "alerts_enabled": true,
  "alert_recipient": "ops@example.com",
  "alert_frequency_ms": 3600000
}
```

#### `query_definition` fields

| Field | Type | Constraints |
|-------|------|-------------|
| `q` | string | Free-text search; injection chars stripped; max 200 chars |
| `status` | string | One of: `draft`, `active`, `completed`, `failed`, `cancelled` |
| `verifier` | string | Stellar address; max 256 chars |
| `amount_min` | string | Non-negative numeric string |
| `amount_max` | string | Non-negative numeric string |
| `date_from` | string | ISO 8601 date |
| `date_to` | string | ISO 8601 date |
| `sort_by` | string | One of: `created_at`, `amount`, `end_date`, `status` |
| `sort_order` | string | `asc` or `desc` |
| `limit` | number | Integer 1–100 |

#### Constraints

- **Per-org cap**: maximum **20** saved searches per org (HTTP 422 on overflow).
- **Alert frequency floor**: `alert_frequency_ms` must be ≥ `3,600,000` ms (1 hour).
- `alert_recipient` is required when `alerts_enabled` is `true`.

### Alert subscriptions

When `alerts_enabled` is `true` the periodic evaluation job re-runs the saved query on a schedule (default every 15 minutes, controlled by `SAVED_SEARCH_EVAL_INTERVAL_MS`). If the result set has changed since the last evaluation (detected by SHA-256 hash comparison), a notification is dispatched to `alert_recipient` via the configured notification provider.

The per-search evaluation frequency is controlled by `alert_frequency_ms`. A search is only evaluated if `now >= last_evaluated_at + alert_frequency_ms`.

### Database

| Table | Migration |
|-------|-----------|
| `org_vault_searches` | `db/migrations/20260628100000_create_org_vault_searches.cjs` |

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `SAVED_SEARCH_EVAL_INTERVAL_MS` | `900000` (15 min) | How often the evaluation job runs |

---

## Soroban Transaction Polling and Timeout

When `onChain.mode` is `"submit"`, the backend sends the transaction to the Soroban RPC and then polls `getTransaction` until the tx reaches a terminal state.

### Polling behaviour

- After `sendTransaction` returns `PENDING` or `TRY_AGAIN_LATER`, the backend enters a bounded poll loop.
- Each poll calls `getTransaction(hash)`.
  - `NOT_FOUND` → sleep `SOROBAN_SUBMIT_POLL_INTERVAL_MS` ms and retry (up to `SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS` attempts).
  - `SUCCESS` → resolve with `{ txHash }`.
  - `FAILED` → throw `Error("Soroban transaction did not succeed: FAILED")`.
- The entire poll window is bounded by `SOROBAN_SUBMIT_TIMEOUT_MS`. If the deadline elapses before a terminal status is reached, a `SorobanTimeoutError` is thrown.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SOROBAN_SUBMIT_TIMEOUT_MS` | `60000` | Hard deadline (ms) for the entire poll window. |
| `SOROBAN_SUBMIT_POLL_INTERVAL_MS` | `1000` | Delay between individual `getTransaction` polls. |
| `SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS` | `30` | Maximum number of poll attempts before giving up. |

### SorobanTimeoutError

`SorobanTimeoutError` is thrown (and surfaced in the submission response as `status: "error"`) when the deadline is exceeded. It carries:

- `txHash` — the transaction hash that was being polled.
- `elapsedMs` — the configured deadline that was exceeded (`SOROBAN_SUBMIT_TIMEOUT_MS`).
- `code` — `"SOROBAN_TIMEOUT"`.
- `status` — `504`.

Example submission response when a timeout occurs:

```json
{
  "mode": "submit",
  "payload": { "..." },
  "submission": {
    "attempted": true,
    "status": "error",
    "error": "Soroban transaction tx-abc123 did not finalise within 60000ms"
  }
}
```

## Soroban Transaction Polling and Timeout

When `onChain.mode` is `"submit"`, the backend polls `getTransaction` after sending the transaction until a terminal state is reached.

### Polling behaviour

- After `sendTransaction` returns `PENDING`, the backend enters a bounded poll loop using `retryWithBackoff`.
- Each poll calls `getTransaction(hash)`:
  - `NOT_FOUND` → sleep `SOROBAN_SUBMIT_POLL_INTERVAL_MS` ms and retry.
  - `SUCCESS` → resolves with `{ txHash }`.
  - `FAILED` → throws an error immediately.
- The entire poll window is bounded by `SOROBAN_SUBMIT_TIMEOUT_MS`. If the deadline elapses, a `SorobanTimeoutError` is thrown.

### Env vars

| Variable | Default | Description |
|---|---|---|
| `SOROBAN_SUBMIT_TIMEOUT_MS` | `60000` | Hard deadline (ms) for the whole poll window. |
| `SOROBAN_SUBMIT_POLL_INTERVAL_MS` | `1000` | Delay between `getTransaction` polls. |
| `SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS` | `30` | Max poll attempts before giving up. |

### SorobanTimeoutError

Thrown when the deadline is exceeded. Carries `txHash`, `elapsedMs`, `code: "SOROBAN_TIMEOUT"`, `status: 504`. Surfaced in the submission response as `status: "error"`.


---

## Org-Scoped Vault Search

`GET /api/orgs/:orgId/vaults/search`

Search an organization's vaults using full-text matching and structured filters.
Results are cursor-paginated for stable, consistent paging across large result sets.

### Authentication & Authorization

Requires a valid JWT in the `Authorization: Bearer <token>` header.
The caller must be a member of the target organization (role: `owner`, `admin`, or `member`).

### Path Parameters

| Parameter | Type   | Description                      |
|-----------|--------|----------------------------------|
| `orgId`   | string | UUID of the organization to search |

### Query Parameters

| Parameter    | Type   | Required | Description |
|--------------|--------|----------|-------------|
| `q`          | string | No       | Full-text search term. Matches the `creator` and `verifier` fields via a PostgreSQL GIN/tsvector index. Falls back to `ILIKE` if the FTS column is unavailable. Max 200 characters after sanitization. |
| `status`     | string | No       | Exact status filter. Accepted values: `draft`, `active`, `completed`, `failed`, `cancelled`. |
| `verifier`   | string | No       | Exact verifier Stellar address match. |
| `amount_min` | string | No       | Minimum vault amount (inclusive). |
| `amount_max` | string | No       | Maximum vault amount (inclusive). |
| `date_from`  | string | No       | Minimum `created_at` timestamp (ISO 8601, inclusive). |
| `date_to`    | string | No       | Maximum `created_at` timestamp (ISO 8601, inclusive). |
| `cursor`     | string | No       | Opaque cursor from the previous page's `next_cursor` field. |
| `limit`      | number | No       | Page size. Range: 1–100. Default: 20. |

### Response

```json
{
  "data": [
    {
      "id": "vault-uuid",
      "creator": "GCREATOR...",
      "verifier": "GVERIFIER...",
      "amount": "1000",
      "status": "active",
      "organization_id": "org-uuid",
      "start_date": "2025-01-01T00:00:00.000Z",
      "end_date": "2025-12-31T00:00:00.000Z",
      "created_at": "2025-03-01T12:00:00.000Z",
      "updated_at": "2025-03-01T12:00:00.000Z"
    }
  ],
  "pagination": {
    "limit": 20,
    "cursor": "<current-cursor-or-null>",
    "next_cursor": "<opaque-base64url-string>",
    "has_more": true,
    "count": 20
  }
}
```

When `has_more` is `false`, `next_cursor` is absent.

### Cursor Pagination

Results are sorted `created_at DESC, id DESC` for stability. To page through results:

1. Make the initial request without a `cursor`.
2. If `pagination.has_more` is `true`, pass `pagination.next_cursor` as the `cursor` query parameter in the next request.
3. Repeat until `has_more` is `false`.

Cursors encode a `(created_at, id)` tuple and are opaque base64url strings. Do not construct or parse them — treat them as black boxes.

### Full-Text Search Index

The `q` parameter is backed by a PostgreSQL GIN index on a `tsvector` column (`search_vector`) covering `creator` and `verifier`. The column is maintained by a database trigger (`trg_vaults_search_vector`) that runs `BEFORE INSERT OR UPDATE` on those columns.

Migration: `db/migrations/20260627000000_add_vault_fts_index.cjs`

Prefix-match semantics (`term:*`) are used so partial terms (e.g. `q=alice`) still match.

### Error Responses

| Status | Condition |
|--------|-----------|
| 400    | `cursor` value is not a valid opaque cursor. Body: `{ "error": "Invalid cursor" }` |
| 401    | Missing or invalid Authorization token. |
| 403    | Caller is not a member of the specified organization. |
| 404    | Organization does not exist. |
| 500    | Unexpected server error. |

### Security Notes

- **Tenant isolation**: Every query is scoped by `WHERE organization_id = :orgId`. This filter runs inside the database engine and cannot be bypassed by client-supplied parameters.
- **Soft-delete awareness**: Vaults with `deleted_at IS NOT NULL` are excluded automatically.
- **Injection safety**: The `q` parameter is sanitised (only word characters, spaces, dots, hyphens and underscores allowed) before being interpolated into a tsquery. All remaining parameters are applied through Knex's parameterized query API — no string concatenation.
- **Rate limiting**: The endpoint shares the organization read rate limiter (`orgReadRateLimiter`), configurable via `ORG_RATE_LIMIT_MAX` / `ORG_RATE_LIMIT_WINDOW_MS`.

### Examples

**Search by text:**
```
GET /api/orgs/org-uuid/vaults/search?q=alice
```

**Filter by status and capital range:**
```
GET /api/orgs/org-uuid/vaults/search?status=active&amount_min=500&amount_max=5000
```

**Combined text + date range:**
```
GET /api/orgs/org-uuid/vaults/search?q=bob&date_from=2025-01-01T00:00:00Z&date_to=2025-06-30T23:59:59Z
```

**Paginate through results:**
```
# Page 1
GET /api/orgs/org-uuid/vaults/search?limit=10

# Page 2 (using next_cursor from page 1 response)
GET /api/orgs/org-uuid/vaults/search?limit=10&cursor=eyJ0aW1lc3RhbXAiO...
```
