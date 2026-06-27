# Idempotency Contract

## Overview

POST `/api/vaults` and POST `/api/verifications` support client-controlled idempotency via the `idempotency-key` request header. Sending the same key with an identical payload returns the original response without creating a duplicate vault or verification decision. Sending the same key with a *different* payload returns a 409 to signal a conflict.

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

| Condition | Status | Notes |
|-----------|--------|-------|
| No `idempotency-key` header | 201 | Normal creation; no deduplication |
| Valid key, first request | 201 | Vault created; response cached server-side |
| Valid key, repeated request, **same** payload | 200 | Cached response replayed; `idempotency.replayed: true` |
| Valid key, repeated request, **different** payload | 409 | Conflict; no side effects |
| Invalid key format | 400 | Key rejected before any business logic |
| Valid key expires after TTL | 201 | Request may execute again after the server-side idempotency TTL elapses |

---

## Response Shape

### 201 – Created (first request)

```json
{
  "vault": { "id": "...", "milestones": [...], ... },
  "onChain": { "payload": { "method": "create_vault", ... } },
  "idempotency": { "key": "my-key", "replayed": false }
}
```

For verification decisions, the same envelope is used with verification fields:

```json
{
  "verification": { "id": "ver-1", "targetId": "milestone-1", ... },
  "evidenceReference": { "id": "ev-1", "verificationId": "ver-1", ... },
  "idempotency": { "key": "my-key", "replayed": false }
}
```

### 200 – Replayed (identical payload)

Same body as the original 201, with `idempotency.replayed` set to `true`:

```json
{
  "vault": { ... },
  "onChain": { ... },
  "idempotency": { "key": "my-key", "replayed": true }
}
```

### 400 – Invalid key format

```json
{
  "error": {
    "code": "INVALID_IDEMPOTENCY_KEY",
    "message": "Idempotency key must be 1–255 characters and contain only letters, digits, hyphens, and underscores."
  }
}
```

### 409 – Conflict (same key, different payload)

```json
{
  "error": {
    "code": "IDEMPOTENCY_CONFLICT",
    "message": "Idempotency key has already been used with a different payload."
  }
}
```

---

## Client Retry Guidance

1. **Generate a key per logical operation**, not per HTTP call. A UUID v4 is the recommended format.
2. **Persist the key** alongside your local record before sending the request. This lets you retry safely after a timeout or network failure.
3. **On 5xx or timeout**: retry with the **same** key and **same** payload. The server will deduplicate.
4. **On 409**: do **not** retry. A different payload was already submitted under this key. Inspect the original request and generate a new key for a new operation.
5. **On 400 (`INVALID_IDEMPOTENCY_KEY`)**: fix the key format before retrying.
6. **On 200 (replay)**: treat this identically to a 201. The `vault.id` or `verification.id` in the body is the canonical resource identifier.

---

## Payload Hashing

The server hashes the request body using SHA-256 over a canonicalised (key-sorted) JSON representation. This ensures that two requests with the same logical content but different property ordering are treated as identical payloads.

---

## Security Assumptions

### Cross-user isolation

Idempotency keys are scoped to the authenticated user. User A and User B can each send requests with the key `my-key` independently without interfering with each other. The server stores keys internally as `{userId}:{clientKey}`, which is opaque to the client.

**Consequence**: a 409 from a given key is always user-specific. It is not possible for one user to trigger a conflict for another user.

### Response poisoning

The value stored in the idempotency cache is always server-generated (never derived from request data). A client cannot influence the cached response content beyond choosing the idempotency key.

### Concurrent same-key submissions

Concurrent submissions with the same key and same payload share the same in-flight server operation. The first request performs the side effect and subsequent in-flight requests wait for that generated response instead of submitting a second verification or vault creation.

### Scope of deduplication

The idempotency guarantee covers `POST /api/vaults` and `POST /api/verifications`. Keys are scoped by endpoint operation and authenticated user, so the same client key can be safely reused for unrelated endpoint families without collision.

---

## Implementation Notes

| Component | Location |
|-----------|----------|
| Key validation | `src/services/idempotency.ts` → `validateIdempotencyKey` |
| Payload hashing | `src/services/idempotency.ts` → `hashRequestPayload` |
| Store read/write | `src/services/idempotency.ts` → `getIdempotentResponse` / `saveIdempotentResponse` / `runIdempotentRequest` |
| Route integration | `src/routes/vaults.ts` and `src/routes/verifications.ts` → `POST /` handlers |
| Unit tests | `src/tests/eventIdempotency.test.ts` (describe blocks: `validateIdempotencyKey`, `hashRequestPayload`, `idempotency store`) |
| Route-level tests | `tests/vaults.test.ts`, `src/routes/vaults.test.ts`, and `src/tests/verifications.idempotency.test.ts` |
