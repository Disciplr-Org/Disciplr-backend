# Configuration Reference

This reference is derived from `src/config/env.ts` and cross-checked against
`.env.example`. `DATABASE_URL` is the only hard-required variable in the schema;
most other values have defaults or are optional feature toggles. In production,
replace every default secret even when the service can technically boot.

## Minimum Config To Boot

For local development, the smallest useful `.env` is:

```dotenv
NODE_ENV=development
DATABASE_URL=postgres://postgres:postgres@localhost:5432/disciplr
JWT_SECRET=replace-with-at-least-16-characters
JWT_ACCESS_SECRET=replace-with-at-least-16-characters
JWT_REFRESH_SECRET=replace-with-at-least-16-characters
DOWNLOAD_SECRET=replace-with-at-least-16-characters
```

For production, also set `CORS_ORIGINS`, all JWT/download secrets, rate limits,
HTTP timeouts that match the load balancer, and any feature-specific variables
for Soroban submit mode, Horizon listening, webhooks, exports, or scheduled jobs.

## Sensitivity Levels

| Level | Meaning |
| --- | --- |
| Secret | Credential, signing key, or token material. Never log or commit real values. |
| Sensitive | Infrastructure or policy value that can expose internals or affect security posture. |
| Public | Operational value that is safe to document, though it may still be environment-specific. |

## Variables

| Variable | Type / format | Default | Required | Sensitivity | Purpose |
| --- | --- | --- | --- | --- | --- |
| `NODE_ENV` | `development`, `production`, or `test` | `development` | No | Public | Selects runtime mode and production-only warnings. |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` | `info` | No | Public | Controls structured log verbosity. |
| `PORT` | Positive integer | `3000` | No | Public | HTTP listener port. |
| `SERVICE_NAME` | String | `disciplr-backend` | No | Public | Service name included in logs. |
| `DATABASE_URL` | `postgres://` or `postgresql://` URL | None | Yes | Sensitive | PostgreSQL connection string for the API and migrations. |
| `CORS_ORIGINS` | Comma-separated `http://` or `https://` origins, or `*` | Unset | No | Sensitive | Allowed browser origins. Empty string is rejected; `*` is rejected in production. |
| `JWT_SECRET` | String, minimum 16 chars | `change-me-in-production-long-secret` | No | Secret | General JWT signing fallback used by auth middleware. |
| `JWT_ACCESS_SECRET` | String, minimum 16 chars | `fallback-access-secret` | No | Secret | Signs short-lived access tokens. |
| `JWT_REFRESH_SECRET` | String, minimum 16 chars | `fallback-refresh-secret` | No | Secret | Signs refresh tokens. |
| `JWT_ACCESS_EXPIRES_IN` | Duration like `15m`, `1h`, `7d` | `15m` | No | Public | Access-token lifetime. |
| `JWT_REFRESH_EXPIRES_IN` | Duration like `7d` | `7d` | No | Public | Refresh-token lifetime. |
| `DOWNLOAD_SECRET` | String, minimum 16 chars | `change-me-in-production-long-secret` | No | Secret | Signs file-download tokens. |
| `JWT_KEYS` | JSON array of `{ "kid", "secret", "retiredAt"? }` | `[]` | No | Secret | Optional JWT key rotation set. |
| `HORIZON_URL` | Optional HTTP(S) URL | Unset | No | Sensitive | Stellar Horizon endpoint for listener and ETL flows. |
| `CONTRACT_ADDRESS` | String | Unset | No | Sensitive | Contract address or addresses monitored by listener paths. |
| `START_LEDGER` | Non-negative integer | `0` | No | Public | Listener starting ledger; `0` means latest/default. |
| `RETRY_MAX_ATTEMPTS` | Non-negative integer | `3` | No | Public | Generic transient retry attempt count. |
| `RETRY_BACKOFF_MS` | Non-negative integer, milliseconds | `100` | No | Public | Initial retry backoff delay. |
| `SOROBAN_CONTRACT_ID` | 56-char contract ID starting with `C` | Unset | Submit mode only | Sensitive | Soroban contract used for on-chain vault operations. |
| `SOROBAN_NETWORK_PASSPHRASE` | String | Unset | Submit mode only | Public | Stellar network passphrase for Soroban transactions. |
| `SOROBAN_SOURCE_ACCOUNT` | Stellar public key | Unset | Submit mode only | Sensitive | Account used as transaction source. |
| `SOROBAN_RPC_URL` | HTTP(S) URL | Unset | Submit mode only | Sensitive | Primary Soroban RPC endpoint. |
| `SOROBAN_RPC_URLS` | Comma-separated URLs | Unset | No | Sensitive | Optional RPC failover list used by Soroban client code. |
| `SOROBAN_SECRET_KEY` | Stellar secret key | Unset | Submit mode only | Secret | Private key for real Soroban submission. |
| `SOROBAN_SUBMIT_POLL_INTERVAL_MS` | Positive integer, milliseconds | `1000` | No | Public | Delay between submit-mode transaction polls. |
| `SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS` | Positive integer | `30` | No | Public | Maximum transaction poll attempts. |
| `SOROBAN_RPC_TIMEOUT_MS` | Positive integer, milliseconds | `30000` | No | Public | Per-RPC request timeout. |
| `SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS` | Positive integer, milliseconds | `5000` | No | Public | Maximum backoff for submit retries. |
| `SOROBAN_SUBMIT_TIMEOUT_MS` | Positive integer, milliseconds | `60000` | No | Public | Overall Soroban submit timeout. |
| `STELLAR_NETWORK_PASSPHRASE` | String | Unset | No | Public | Network passphrase used by ETL or Stellar helper code. |
| `JOB_WORKER_CONCURRENCY` | Positive integer | `2` | No | Public | Background worker concurrency. |
| `JOB_QUEUE_POLL_INTERVAL_MS` | Positive integer, milliseconds | `250` | No | Public | Poll interval for the in-memory job queue. |
| `JOB_HISTORY_LIMIT` | Positive integer | `50` | No | Public | Number of historical jobs retained in memory. |
| `ENABLE_JOB_SCHEDULER` | String flag | Unset | No | Public | Set to `false` to disable recurring scheduled jobs. |
| `NOTIFICATION_PROVIDER` | Provider name, usually `console` or `email` | `console` in call sites | No | Public | Default notification provider. |
| `ETL_INTERVAL_MINUTES` | Positive integer | `5` | No | Public | ETL worker interval in minutes. |
| `ENABLE_ETL_WORKER` | String flag | Unset | No | Public | Set to `false` to disable ETL startup in `src/index.ts`. |
| `ETL_BACKFILL_FROM` | Date/time string | Unset | No | Public | Optional ETL backfill lower bound. |
| `ETL_BACKFILL_TO` | Date/time string | Unset | No | Public | Optional ETL backfill upper bound. |
| `SECURITY_RATE_LIMIT_WINDOW_MS` | Positive integer, milliseconds | `60000` | No | Public | Abuse monitor rate-limit lookback window. |
| `SECURITY_RATE_LIMIT_MAX_REQUESTS` | Positive integer | `120` | No | Public | Max requests per source in rate-limit window. |
| `SECURITY_SUSPICIOUS_WINDOW_MS` | Positive integer, milliseconds | `300000` | No | Public | Lookback window for suspicious-pattern detection. |
| `SECURITY_SUSPICIOUS_404_THRESHOLD` | Positive integer | `20` | No | Public | 404 count threshold for endpoint scan alerts. |
| `SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD` | Positive integer | `12` | No | Public | Distinct 404 path threshold for endpoint scan alerts. |
| `SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD` | Positive integer | `30` | No | Public | 400 count threshold for repeated bad-request alerts. |
| `SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD` | Positive integer | `300` | No | Public | High-volume request threshold. |
| `SECURITY_FAILED_LOGIN_WINDOW_MS` | Positive integer, milliseconds | `900000` | No | Public | Failed-login burst lookback window. |
| `SECURITY_FAILED_LOGIN_BURST_THRESHOLD` | Positive integer | `5` | No | Public | Failed-login count threshold per source. |
| `SECURITY_ALERT_COOLDOWN_MS` | Positive integer, milliseconds | `300000` | No | Public | Minimum time between repeated alerts per source/pattern. |
| `ORG_RATE_LIMIT_MAX` | Positive integer | `200` | No | Public | Per-organization request limit. |
| `ORG_RATE_LIMIT_WINDOW_MS` | Positive integer, milliseconds | `60000` | No | Public | Per-organization rate-limit window. |
| `EXPORT_DAILY_QUOTA_LIMIT` | Positive integer | `100` | No | Public | Daily export quota per organization. |
| `DEADLINE_CHECK_INTERVAL_MS` | Positive integer, milliseconds | `60000` | No | Public | Deadline scheduler interval. |
| `ANALYTICS_RECOMPUTE_INTERVAL_MS` | Positive integer, milliseconds | `300000` | No | Public | Analytics recompute scheduler interval. |
| `MAX_JSON_BODY_SIZE` | Express body-parser size string | `500kb` | No | Public | Maximum accepted JSON request body size. |
| `HORIZON_LAG_THRESHOLD` | Non-negative integer | `10` | No | Public | Horizon listener lag threshold. |
| `HORIZON_SHUTDOWN_TIMEOUT_MS` | Positive integer, milliseconds | `30000` | No | Public | Horizon listener shutdown timeout. |
| `WEBHOOK_INBOUND_SECRET` | String | Unset | No | Secret | Secret for verifying inbound webhook signatures. |
| `WEBHOOK_INBOUND_SKEW_MS` | Positive integer, milliseconds | `300000` | No | Public | Allowed inbound webhook timestamp skew. |
| `EXPORT_S3_BUCKET` | String | Unset | No | Sensitive | Enables S3 export storage when paired with region. |
| `EXPORT_S3_REGION` | String | Unset | No | Sensitive | AWS region for export S3 bucket. |
| `EXPORT_SIGNED_URL_TTL_S` | Positive integer, seconds | `3600` | No | Public | Signed export URL lifetime. |
| `HTTP_KEEPALIVE_TIMEOUT_MS` | Positive integer, milliseconds | `45000` | No | Public | Node keep-alive timeout; must be less than headers timeout. |
| `HTTP_HEADERS_TIMEOUT_MS` | Positive integer, milliseconds | `61000` | No | Public | Node headers timeout; must be less than request timeout. |
| `HTTP_REQUEST_TIMEOUT_MS` | Positive integer, milliseconds | `120000` | No | Public | Full request lifecycle timeout. |

## Feature-Specific Requirements

### Soroban Submit Mode

Submit mode is considered configured only when all of these are present:

- `SOROBAN_CONTRACT_ID`
- `SOROBAN_NETWORK_PASSPHRASE`
- `SOROBAN_SOURCE_ACCOUNT`
- `SOROBAN_RPC_URL` or `SOROBAN_RPC_URLS`
- `SOROBAN_SECRET_KEY`

If only part of the Soroban set is present, `initEnv()` records a non-fatal
warning and submit mode should remain disabled.

### Horizon Listener

Listener paths use `HORIZON_URL`, `CONTRACT_ADDRESS`, `START_LEDGER`,
`RETRY_MAX_ATTEMPTS`, `RETRY_BACKOFF_MS`, `HORIZON_LAG_THRESHOLD`, and
`HORIZON_SHUTDOWN_TIMEOUT_MS`. Set `HORIZON_URL` and `CONTRACT_ADDRESS` together
when enabling the listener.

### Exports

`EXPORT_S3_BUCKET` and `EXPORT_S3_REGION` enable S3-backed export storage when
both are set. `EXPORT_SIGNED_URL_TTL_S` controls signed download URL lifetime,
and `EXPORT_DAILY_QUOTA_LIMIT` controls per-org export quota checks.

## Drift Check

This document intentionally includes variables that are validated in
`src/config/env.ts` but not yet present in `.env.example`, such as scheduler,
HTTP timeout, webhook, and S3 export settings. When adding a new variable, update
all three places together:

- `src/config/env.ts`
- `.env.example`
- `docs/configuration.md`
