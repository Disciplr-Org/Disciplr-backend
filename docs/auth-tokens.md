# Authentication Tokens

This document describes the JWT access token and refresh token system used by Disciplr's authentication layer.

## Token Types

### Access Token (JWT)

Short-lived token used for authenticating API requests.

| Claim | Type | Description |
|-------|------|-------------|
| `sub` | `string` | User ID (standard JWT subject claim) |
| `userId` | `string` | User ID (backward compatibility alias) |
| `role` | `string` | User role: `USER`, `VERIFIER`, or `ADMIN` |
| `jti` | `string` | Unique token identifier (UUID v4) — used for session tracking |
| `iss` | `string` | Issuer — always `disciplr` |
| `aud` | `string` | Audience — always `disciplr-api` |
| `iat` | `number` | Issued-at timestamp (seconds since epoch) |
| `exp` | `number` | Expiration timestamp (default: 15 minutes after `iat`) |

**Signed with:** `JWT_ACCESS_SECRET` (HS256)

### Refresh Token (JWT)

Longer-lived token used to obtain new access/refresh token pairs.

| Claim | Type | Description |
|-------|------|-------------|
| `userId` | `string` | User ID |
| `iat` | `number` | Issued-at timestamp |
| `exp` | `number` | Expiration timestamp (default: 7 days after `iat`) |

**Signed with:** `JWT_REFRESH_SECRET` (HS256)

**Storage:** Refresh tokens are hashed (SHA-256) before being persisted in the `RefreshToken` table. The raw token is only ever held in memory or transmitted to the client — it is never stored in plaintext in the database.

## Token Lifecycle

### Login (`POST /api/auth/login`)

```
Client                          Server
  |--- email + password ----------->|
  |                                 | 1. Validate credentials
  |                                 | 2. Generate access token (with jti)
  |                                 | 3. Record session (jti → sessions table)
  |                                 | 4. Generate refresh token
  |                                 | 5. Hash refresh token (SHA-256)
  |                                 | 6. Store hash in RefreshToken table
  |<-- { accessToken, refreshToken }-|
```

### Refresh (`POST /api/auth/refresh`)

```
Client                          Server
  |--- { refreshToken } ----------->|
  |                                 | 1. Verify JWT signature
  |                                 | 2. Hash incoming token
  |                                 | 3. Look up hash in RefreshToken table
  |                                 | 4. Check: not revoked, not expired
  |                                 | 5. Revoke old refresh token (set revokedAt)
  |                                 | 6. Issue new access + refresh tokens
  |                                 | 7. Store new refresh token hash
  |<-- { accessToken, refreshToken }-|
```

### Logout (`POST /api/auth/logout`)

Revokes the current session and specific refresh token:
1. Revokes the access token session via `jti` (marks `revoked_at` in `sessions` table)
2. Hashes the provided refresh token and marks it as revoked in `RefreshToken` table

### Logout All (`POST /api/auth/logout-all`)

Revokes **all** sessions and refresh tokens for the user:
1. Revokes all access token sessions for the user in the `sessions` table
2. Revokes all refresh tokens for the user in the `RefreshToken` table

## Rotation Rules

1. **Every refresh rotates tokens.** When a refresh token is used, it is immediately revoked and a new pair (access + refresh) is issued. The old refresh token cannot be reused.

2. **One-time use.** Each refresh token can only be used once. Attempting to reuse a revoked refresh token returns `401`.

3. **Old tokens die immediately.** The revocation happens _before_ new tokens are issued — there is no window where both old and new tokens are valid.

## Revocation Semantics

### Access Token Revocation
- Access tokens contain a `jti` (JWT ID) that is recorded in the `sessions` table.
- The `authenticate` middleware checks the `sessions` table on every request to verify the session is not revoked.
- Revoking a session sets `revoked_at` on the session record.

### Refresh Token Revocation
- Refresh tokens are hashed and stored in the `RefreshToken` table (Prisma).
- Revocation sets the `revokedAt` timestamp on the record.
- Both single-token revocation (`logout`) and bulk revocation (`logout-all`) are supported.

## Threat Model

| Threat | Mitigation |
|--------|------------|
| **Refresh token theft** | Tokens are hashed before storage — a database breach does not expose usable tokens. Token rotation means a stolen token has a limited reuse window. |
| **Replay attack (reuse of rotated token)** | Old refresh tokens are revoked immediately on rotation. Any reuse attempt returns `401`. |
| **Access token theft** | Short expiry (15 min default). Session can be revoked server-side via `jti` lookup, providing immediate invalidation. |
| **Weak signing keys** | Startup validation rejects secrets shorter than 32 characters in production. Warns in development. |
| **Clock skew** | JWT verification includes 30-second clock tolerance to handle minor system clock differences. |
| **Key compromise** | Separate secrets for access and refresh tokens. Compromising one does not compromise the other. Rotate secrets and invalidate all sessions if a breach is suspected. |

## Configuration

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `JWT_ACCESS_SECRET` | `fallback-access-secret` | Secret for signing access tokens |
| `JWT_REFRESH_SECRET` | `fallback-refresh-secret` | Secret for signing refresh tokens |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Access token lifetime |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token lifetime |
| `SESSIONS_CLEANUP_INTERVAL_MS` | `86400000` (24 h) | How often the cleanup job runs |

> **Warning:** The fallback secrets are for development only. In production, set real secrets of at least 32 characters.

## Session Table Cleanup

The `sessions` table is pruned by the `sessions.cleanup` background job to prevent unbounded growth.

### What it deletes

Rows where `expires_at < now() - interval '30 days'`. Active or recently-expired sessions (within the 30-day grace window) are never touched.

### How it runs

The job is scheduled automatically at startup (with a 10-second delay to let the server warm up) and then repeats every 24 hours. It uses a batched `DELETE … LIMIT 1000` loop so large backlogs are processed incrementally without long-running locks.

### Observability

After each run the job logs:

```
[jobs:sessions.cleanup] deleted=<N> batchSize=<B> attempt=<A>
```

### Manual trigger

Enqueue an ad-hoc run via the jobs API:

```bash
curl -X POST http://localhost:3000/api/jobs/enqueue \
  -H "Content-Type: application/json" \
  -d '{"type": "sessions.cleanup", "payload": {}}'
```

Pass an optional `batchSize` (default `1000`) to tune throughput:

```bash
curl -X POST http://localhost:3000/api/jobs/enqueue \
  -H "Content-Type: application/json" \
  -d '{"type": "sessions.cleanup", "payload": {"batchSize": 500}}'
```
