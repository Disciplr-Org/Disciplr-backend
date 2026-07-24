# Idempotency Contract

## Overview

Select POST endpoints support client-controlled idempotency via the `idempotency-key` request header. Sending the same key with an identical payload returns the original response without creating a duplicate resource. Sending the same key with a *different* payload returns a 409 to signal a conflict.

Covered endpoints:

- `POST /api/vaults`
- `POST /api/verifications`

Every idempotency key is bound to the authenticated principal (user + org) that first used it. A key can only be replayed by its original owner — a different user or org attempting to replay the same key string receives a 403 without seeing the stored response.

---

## Key Format

| Property | Requirement |
|----------|-------------|
| Charset  | Letters (`A–Z`, `a–z`), digits (`0–9`), hyphens (`-`), underscores (`_`) |
| Length   | 1–255 characters |
| Header   | `idempotency-key` (lowercase, HTTP/1.1 header name) |

Valid examples:
```
idempotency-key: 550e8400-e29b-41d4-a716-446655440000   # UUID
idempotency-key: vault-req-20240101-abc123               # prefixed timestamp
idempotency-key: my_vault_creation_1                     # underscore style
```

Invalid examples (→ 400):
```
idempotency-key:                         # empty
idempotency-key: key with spaces         # spaces not allowed
idempotency-key: key@value!              # special characters not allowed
idempotency-key: <256 chars>             # exceeds maximum length
```

---

## Behaviour Matrix

The following matrix applies to all covered endpoints. Status codes in the "Created" column differ by endpoint (201 for both vaults and verifications).

| Condition | Status | Notes |
|-----------|--------|-------|
| No `idempotency-key` header | 201 | Normal creation; no deduplication |
| Valid key, first request | 201 | Vault created; response cached and bound to caller |
| Valid key, repeated request, **same** payload, **same owner** | 200 | Cached response replayed; `idempotency.replayed: true` |
| Valid key, repeated request, **different** payload, same owner | 409 | Conflict; no side effects |
| Valid key, request from **different user or org** | 403 | Owner mismatch; stored response never disclosed |
| Invalid key format | 400 | Key rejected before any business logic |

---

## Response Shapes

### POST /api/vaults

#### 201 – Created (first request)

```json
{
  "vault": { "id": "...", "milestones": [...], ... },
  "onChain": { "payload": { "method": "create_vault", ... } },
  "idempotency": { "key": "my-key", "replayed": false }
}
```

### 200 – Replayed (identical payload, same owner)

Same body as the original 201, with `idempotency.replayed` set to `true`:

```json
{
  "vault": { ... },
  "onChain": { ... },
  "idempotency": { "key": "my-key", "replayed": true }
}
```

### POST /api/verifications

#### 201 – Created (first request)

```json
{
  "verification": { "id": "...", "targetId": "...", "result": "approved", ... },
  "evidenceReference": { "id": "...", "referenceUrl": "...", ... },
  "idempotency": { "key": "my-key", "replayed": false }
}
```

#### 200 – Replayed (identical payload)

Same body as the original 201, with `idempotency.replayed` set to `true`:

```json
{
  "verification": { ... },
  "evidenceReference": { ... },
  "idempotency": { "key": "my-key", "replayed": true }
}
```

### Error Responses (all endpoints)

#### 400 – Invalid key format

```json
{
  "error": {
    "code": "INVALID_IDEMPOTENCY_KEY",
    "message": "Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores."
  }
}
```

### 403 – Owner mismatch (different user or org attempting replay)

```json
{
  "error": {
    "code": "IDEMPOTENCY_OWNER_MISMATCH",
    "message": "Idempotency key belongs to a different owner"
  }
}
```

### 409 – Conflict (same key, different payload)

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency key conflict"
  }
}
```

---

## Client Retry Guidance

1. **Generate a key per logical operation**, not per HTTP call. A UUID v4 is the recommended format.
2. **Persist the key** alongside your local record before sending the request. This lets you retry safely after a timeout or network failure.
3. **On 5xx or timeout**: retry with the **same** key and **same** payload. The server will deduplicate.
4. **On 409**: do **not** retry. A different payload was already submitted under this key. Inspect the original request and generate a new key for a new operation.
5. **On 403 (`IDEMPOTENCY_OWNER_MISMATCH`)**: the key was originally issued by a different principal. Generate a new key.
6. **On 400 (`INVALID_IDEMPOTENCY_KEY`)**: fix the key format before retrying.
7. **On 200 (replay)**: treat this identically to a 201. The `vault.id` in the body is the canonical resource identifier.

---

## Payload Hashing

The server hashes the request body using SHA-256 over a canonicalised (key-sorted) JSON representation. This ensures that two requests with the same logical content but different property ordering are treated as identical payloads.

---

## Security Assumptions

### Cross-user isolation (owner binding)

Every stored idempotency key is bound to the `userId` and `orgId` of the authenticated principal at write time. On replay the server compares the requesting principal against the stored owner:

- **Same userId + same orgId** → replay allowed (exactly-once guarantee for the original owner).
- **Different userId or different orgId** → 403 returned; the stored response body is **never** disclosed.
- **Legacy / anonymous keys** (stored before owner binding was deployed, `user_id IS NULL AND org_id IS NULL`) → any caller may replay for backward compatibility.

The owner check happens **before** the hash check, so a cross-user attempt never produces a 409 or reveals whether the key was used with a matching payload.

### Response poisoning

The value stored in the idempotency cache is always server-generated (never derived from request data). A client cannot influence the cached response content beyond choosing the idempotency key.

### Scope of deduplication

The idempotency guarantee is per-endpoint. Each endpoint maintains its own key namespace. A key used against `POST /api/vaults` does not conflict with the same key used against `POST /api/verifications`.

---

## Migration

Owner columns were added in migration `20260628000000_add_owner_to_idempotency_keys.cjs`:

```sql
ALTER TABLE idempotency_keys ADD COLUMN user_id VARCHAR(255);
ALTER TABLE idempotency_keys ADD COLUMN org_id  VARCHAR(255);
CREATE INDEX idx_idempotency_keys_user_id ON idempotency_keys (user_id);
CREATE INDEX idx_idempotency_keys_org_id  ON idempotency_keys (org_id);
```

Rows present before the migration receive `NULL` for both columns and are treated as legacy/anonymous entries.

---

## Implementation Notes

| Component | Location |
|-----------|----------|
| Key validation | `src/services/idempotency.ts` → `validateIdempotencyKey` |
| Key scoping | `src/services/idempotency.ts` → `scopeIdempotencyKey` |
| Owner context type | `src/services/idempotency.ts` → `OwnerContext` |
| Owner mismatch error | `src/services/idempotency.ts` → `IdempotencyOwnerMismatchError` |
| Payload hashing | `src/services/idempotency.ts` → `hashRequestPayload` |
| Store read/write | `src/services/idempotency.ts` → `getIdempotentResponse` / `saveIdempotentResponse` |
| DB service | `src/services/idempotency.ts` → `IdempotencyService.getStoredResponse` / `storeResponse` |
| Route integration (vaults) | `src/routes/vaults.ts` → `POST /` handler (owner extracted from `req.user` / `req.apiKeyAuth`) |
| Route integration (verifications) | `src/routes/verifications.ts` → `POST /` handler |
| Unit tests | `src/tests/eventIdempotency.test.ts` |
| Route-level tests (vaults) | `tests/vaults.test.ts` and `src/routes/vaults.test.ts` |
| Route-level tests (verifications) | `src/tests/verifications.idempotency.test.ts` |
| Owner-binding tests | `src/tests/idempotency.ownerBinding.test.ts` |
| DB migration | `db/migrations/20260628000000_add_owner_to_idempotency_keys.cjs` |
