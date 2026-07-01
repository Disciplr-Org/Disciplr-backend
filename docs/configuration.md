# Configuration Reference

This document provides a complete reference for all environment variables consumed by **disciplr-backend**. Every variable listed here is validated in [`src/config/env.ts`](../src/config/env.ts).

## Table of Contents

1. [Minimum Configuration to Boot](#minimum-configuration-to-boot)
2. [Core Runtime](#core-runtime)
3. [Database & Redis](#database--redis)
4. [Authentication & Secrets](#authentication--secrets)
5. [Stellar / Soroban](#stellar--soroban)
6. [HTTP Server Timeouts](#http-server-timeouts)
7. [Job System](#job-system)
8. [ETL](#etl)
9. [Metrics & Monitoring](#metrics--monitoring)
10. [Security Thresholds](#security-thresholds)
11. [Scheduled Jobs](#scheduled-jobs)
12. [Webhooks](#webhooks)
13. [Exports & S3](#exports--s3)
14. [Logging](#logging)

---

## Minimum Configuration to Boot

To start the application, you **must** provide at least:

```bash
NODE_ENV=production
DATABASE_URL=postgres://user:pass@host:5432/dbname
JWT_SECRET=<min-16-chars>
JWT_ACCESS_SECRET=<min-16-chars>
JWT_REFRESH_SECRET=<min-16-chars>
DOWNLOAD_SECRET=<min-16-chars>
```

All other variables have safe defaults suitable for local development.

> **⚠️ In Production:** Replace all `*_SECRET` defaults immediately. See [Security Guidelines](#security-guidelines) below.

---

## Core Runtime

### NODE_ENV

| Property | Value |
|----------|-------|
| **Type** | `enum` |
| **Valid Values** | `development`, `production`, `test` |
| **Default** | `development` |
| **Required** | No |
| **Sensitive** | No |

Runtime environment influencing behavior, logging, and security checks.

```bash
NODE_ENV=production
```

### PORT

| Property | Value |
|----------|-------|
| **Type** | Positive Integer |
| **Default** | `3000` |
| **Required** | No |
| **Sensitive** | No |

TCP port on which the HTTP server listens.

```bash
PORT=8080
```

### SERVICE_NAME

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | `disciplr-backend` |
| **Required** | No |
| **Sensitive** | No |

Logical service name included in structured log output and metrics.

```bash
SERVICE_NAME=disciplr-backend
```

### LOG_LEVEL

| Property | Value |
|----------|-------|
| **Type** | `enum` |
| **Valid Values** | `debug`, `info`, `warn`, `error` |
| **Default** | `info` |
| **Required** | No |
| **Sensitive** | No |

Minimum log level for console and structured log output.

```bash
LOG_LEVEL=debug
```

---

## Database & Redis

### DATABASE_URL

| Property | Value |
|----------|-------|
| **Type** | PostgreSQL Connection String |
| **Default** | *(none)* |
| **Required** | ✅ **Yes** |
| **Sensitive** | ✅ **Yes** — contains credentials |

PostgreSQL connection URL. Must start with `postgres://` or `postgresql://`.

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/disciplr
```

The connection is validated at startup; invalid URLs cause immediate failure.

### REDIS_URL

| Property | Value |
|----------|-------|
| **Type** | Redis Connection String |
| **Default** | *(none — Redis is optional)* |
| **Required** | No |
| **Sensitive** | ✅ **Yes** — contains credentials |

Redis connection URL (optional). When provided, must start with `redis://` or `rediss://` (SSL).

```bash
REDIS_URL=redis://localhost:6379
REDIS_URL=rediss://user:password@redis.example.com:6380
```

If omitted, job queue and caching features degrade gracefully or use memory-based fallbacks.

---

## Authentication & Secrets

### JWT_SECRET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Min Length** | 16 characters |
| **Default** | `change-me-in-production-long-secret` |
| **Required** | No (has default) |
| **Sensitive** | ✅ **Critical** — Must change in production |

General-purpose JWT signing secret. Used as a fallback if `JWT_ACCESS_SECRET` or `JWT_REFRESH_SECRET` are not set independently.

```bash
JWT_SECRET=your-secret-key-at-least-16-characters-long
```

> **⚠️ Production Warning:** The default value is **NOT secure**. Replace immediately in production to prevent unauthorized token generation.

### JWT_ACCESS_SECRET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Min Length** | 16 characters |
| **Default** | `fallback-access-secret` |
| **Required** | No (has default) |
| **Sensitive** | ✅ **Critical** — Must change in production |

Secret used to sign and verify short-lived access tokens (e.g., 15m lifetime).

```bash
JWT_ACCESS_SECRET=your-access-secret-at-least-16-characters-long
```

### JWT_REFRESH_SECRET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Min Length** | 16 characters |
| **Default** | `fallback-refresh-secret` |
| **Required** | No (has default) |
| **Sensitive** | ✅ **Critical** — Must change in production |

Secret used to sign and verify long-lived refresh tokens (e.g., 7d lifetime).

```bash
JWT_REFRESH_SECRET=your-refresh-secret-at-least-16-characters-long
```

### JWT_ACCESS_EXPIRES_IN

| Property | Value |
|----------|-------|
| **Type** | Duration string (`<number><unit>`) |
| **Valid Units** | `s` (seconds), `m` (minutes), `h` (hours), `d` (days) |
| **Default** | `15m` |
| **Required** | No |
| **Sensitive** | No |

Lifetime of access tokens.

```bash
JWT_ACCESS_EXPIRES_IN=30m
```

### JWT_REFRESH_EXPIRES_IN

| Property | Value |
|----------|-------|
| **Type** | Duration string |
| **Default** | `7d` |
| **Required** | No |
| **Sensitive** | No |

Lifetime of refresh tokens.

```bash
JWT_REFRESH_EXPIRES_IN=30d
```

### JWT_KEYS

| Property | Value |
|----------|-------|
| **Type** | JSON-encoded array |
| **Default** | `[]` (empty array) |
| **Required** | No |
| **Sensitive** | ✅ **Yes** — each entry contains a secret |

Optional key rotation configuration. Array of JWT keys with `kid` (key ID), `secret`, and optional `retiredAt` (ISO 8601 date).

```bash
JWT_KEYS='[{"kid":"2024-01","secret":"new-secret-2024-01-at-least-16-chars"},{"kid":"2023-12","secret":"old-secret-2023-12-at-least-16-chars","retiredAt":"2024-01-01T00:00:00Z"}]'
```

Enables seamless JWT key rotation: new keys sign tokens, old keys verify tokens until `retiredAt`.

### DOWNLOAD_SECRET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Min Length** | 16 characters |
| **Default** | `change-me-in-production-long-secret` |
| **Required** | No (has default) |
| **Sensitive** | ✅ **Critical** — Must change in production |

Secret used to sign file-download tokens.

```bash
DOWNLOAD_SECRET=your-download-secret-at-least-16-characters-long
```

---

## Stellar / Soroban

### HORIZON_URL

| Property | Value |
|----------|-------|
| **Type** | HTTP/HTTPS URL |
| **Default** | *(none)* |
| **Required** | Conditional — required if Horizon listener is active |
| **Sensitive** | No |

Stellar Horizon API endpoint for blockchain queries and event streaming.

```bash
HORIZON_URL=https://horizon-testnet.stellar.org
HORIZON_URL=https://horizon.stellar.org
```

### CONTRACT_ADDRESS

| Property | Value |
|----------|-------|
| **Type** | String (Soroban contract address) |
| **Default** | *(none)* |
| **Required** | Conditional — required if using the Horizon listener |
| **Sensitive** | No |

Soroban contract address to monitor. Multiple addresses may be comma-separated if supported.

```bash
CONTRACT_ADDRESS=CDISCIPLR1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890
```

### START_LEDGER

| Property | Value |
|----------|-------|
| **Type** | Non-negative integer |
| **Default** | `0` (start from latest ledger) |
| **Required** | No |
| **Sensitive** | No |

Starting ledger sequence number for Horizon event streaming. Set `0` to start from the latest ledger.

```bash
START_LEDGER=1000000
```

### RETRY_MAX_ATTEMPTS

| Property | Value |
|----------|-------|
| **Type** | Non-negative integer |
| **Default** | `3` |
| **Required** | No |
| **Sensitive** | No |

Maximum retry attempts for transient Horizon errors.

```bash
RETRY_MAX_ATTEMPTS=5
```

### RETRY_BACKOFF_MS

| Property | Value |
|----------|-------|
| **Type** | Non-negative integer (milliseconds) |
| **Default** | `100` |
| **Required** | No |
| **Sensitive** | No |

Initial backoff delay (in milliseconds) for exponential retry strategy on Horizon errors.

```bash
RETRY_BACKOFF_MS=200
```

### SOROBAN_CONTRACT_ID

| Property | Value |
|----------|-------|
| **Type** | String (56-char base32, starts with `C`) |
| **Default** | *(none)* |
| **Required** | Conditional — required for submit mode |
| **Sensitive** | No |

Soroban contract ID for on-chain vault creation and submission.

```bash
SOROBAN_CONTRACT_ID=CDISCIPLR1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890
```

**Submit mode** is enabled only if **all** of the following are set:
- `SOROBAN_CONTRACT_ID`
- `SOROBAN_NETWORK_PASSPHRASE`
- `SOROBAN_SOURCE_ACCOUNT`
- `SOROBAN_RPC_URL`
- `SOROBAN_SECRET_KEY`

If any are missing, submit mode is disabled and a warning is logged.

### SOROBAN_NETWORK_PASSPHRASE

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | Conditional — required for submit mode |
| **Sensitive** | No |

Stellar network passphrase (e.g., `"Test SDF Network ; September 2015"` for testnet, `"Public Global Stellar Network ; September 2015"` for mainnet).

```bash
SOROBAN_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

### SOROBAN_SOURCE_ACCOUNT

| Property | Value |
|----------|-------|
| **Type** | String (Stellar public key, starts with `G`) |
| **Default** | *(none)* |
| **Required** | Conditional — required for submit mode |
| **Sensitive** | No |

Stellar public key to use as the source account for vault creation transactions.

```bash
SOROBAN_SOURCE_ACCOUNT=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
```

### SOROBAN_RPC_URL

| Property | Value |
|----------|-------|
| **Type** | HTTP/HTTPS URL |
| **Default** | *(none)* |
| **Required** | Conditional — required for submit mode |
| **Sensitive** | No |

Soroban RPC endpoint for transaction submission.

```bash
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

### SOROBAN_SECRET_KEY

| Property | Value |
|----------|-------|
| **Type** | String (Stellar secret key, starts with `S`) |
| **Default** | *(none)* |
| **Required** | Conditional — required for submit mode |
| **Sensitive** | ✅ **Critical** — private key material |

Stellar secret key for signing transactions on behalf of the source account.

```bash
SOROBAN_SECRET_KEY=SBXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

> ⚠️ **Never commit this to version control.** Use secure secret management (e.g., HashiCorp Vault, AWS Secrets Manager).

### SOROBAN_RPC_URLS

| Property | Value |
|----------|-------|
| **Type** | String (comma-separated URLs) |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Alternative: list of Soroban RPC URLs for failover or load-balancing.

```bash
SOROBAN_RPC_URLS=https://soroban-testnet.stellar.org,https://soroban-backup.stellar.org
```

### SOROBAN_SUBMIT_POLL_INTERVAL_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `1000` |
| **Required** | No |
| **Sensitive** | No |

Polling interval when checking for transaction confirmation after submission.

```bash
SOROBAN_SUBMIT_POLL_INTERVAL_MS=500
```

### SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `30` |
| **Required** | No |
| **Sensitive** | No |

Maximum polling attempts before timing out on transaction confirmation.

```bash
SOROBAN_SUBMIT_POLL_MAX_ATTEMPTS=60
```

### SOROBAN_RPC_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `30000` |
| **Required** | No |
| **Sensitive** | No |

HTTP request timeout for Soroban RPC calls.

```bash
SOROBAN_RPC_TIMEOUT_MS=45000
```

### SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `5000` |
| **Required** | No |
| **Sensitive** | No |

Maximum backoff delay for exponential retry on Soroban submission errors.

```bash
SOROBAN_SUBMIT_RETRY_MAX_BACKOFF_MS=10000
```

### SOROBAN_SUBMIT_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `60000` |
| **Required** | No |
| **Sensitive** | No |

Total timeout for the entire Soroban submission flow (submit + poll).

```bash
SOROBAN_SUBMIT_TIMEOUT_MS=120000
```

### STELLAR_NETWORK_PASSPHRASE

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Stellar network passphrase (alternative to or additional context for Soroban operations).

```bash
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
```

---

## HTTP Server Timeouts

These variables protect against slow-loris attacks and load-balancer connection drops. Validate relationships at startup.

### HTTP_KEEPALIVE_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `45000` |
| **Required** | No |
| **Sensitive** | No |

Keep-alive socket timeout. Must be **less than** `HTTP_HEADERS_TIMEOUT_MS`.

```bash
HTTP_KEEPALIVE_TIMEOUT_MS=45000
```

### HTTP_HEADERS_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `61000` |
| **Required** | No |
| **Sensitive** | No |

Server-level timeout for headers. Must be **greater than** `HTTP_KEEPALIVE_TIMEOUT_MS` and **less than** `HTTP_REQUEST_TIMEOUT_MS`.

```bash
HTTP_HEADERS_TIMEOUT_MS=61000
```

> **Rationale:** Slightly above 60s to accommodate AWS ALB idle timeout defaults.

### HTTP_REQUEST_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `120000` |
| **Required** | No |
| **Sensitive** | No |

Full request lifecycle timeout. Must be **greater than** `HTTP_HEADERS_TIMEOUT_MS`.

```bash
HTTP_REQUEST_TIMEOUT_MS=120000
```

> **Constraint Check:** At startup, the following relationship is validated:
> ```
> HTTP_KEEPALIVE_TIMEOUT_MS < HTTP_HEADERS_TIMEOUT_MS < HTTP_REQUEST_TIMEOUT_MS
> ```

---

## Job System

### JOB_WORKER_CONCURRENCY

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `2` |
| **Required** | No |
| **Sensitive** | No |

Number of concurrent job workers processing the queue.

```bash
JOB_WORKER_CONCURRENCY=4
```

### JOB_QUEUE_POLL_INTERVAL_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `250` |
| **Required** | No |
| **Sensitive** | No |

Polling interval for the job queue (how often workers check for new jobs).

```bash
JOB_QUEUE_POLL_INTERVAL_MS=500
```

### JOB_HISTORY_LIMIT

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `50` |
| **Required** | No |
| **Sensitive** | No |

Number of completed/failed job records to retain in memory.

```bash
JOB_HISTORY_LIMIT=100
```

### ENABLE_JOB_SCHEDULER

| Property | Value |
|----------|-------|
| **Type** | String (any non-empty value enables) |
| **Default** | *(none — disabled by default)* |
| **Required** | No |
| **Sensitive** | No |

Enable the job scheduler for recurring jobs (e.g., deadline checks, analytics recompute).

```bash
ENABLE_JOB_SCHEDULER=true
```

When enabled, ensures only one scheduler instance runs (even in multi-instance deployments).

### NOTIFICATION_PROVIDER

| Property | Value |
|----------|-------|
| **Type** | `enum` |
| **Valid Values** | `email`, `console` |
| **Default** | `console` |
| **Required** | No |
| **Sensitive** | No |

Backend for sending notifications (jobs of type `notification.send`).

```bash
NOTIFICATION_PROVIDER=email
```

- `console`: Logs notifications to stdout (development).
- `email`: Sends via configured email provider (production).

---

## ETL

### ETL_INTERVAL_MINUTES

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `5` |
| **Required** | No |
| **Sensitive** | No |

Interval (in minutes) for ETL job scheduler to trigger data collection.

```bash
ETL_INTERVAL_MINUTES=10
```

### ENABLE_ETL_WORKER

| Property | Value |
|----------|-------|
| **Type** | String (any non-empty value enables) |
| **Default** | *(none — disabled by default)* |
| **Required** | No |
| **Sensitive** | No |

Enable the ETL worker for background data collection.

```bash
ENABLE_ETL_WORKER=true
```

### ETL_BACKFILL_FROM

| Property | Value |
|----------|-------|
| **Type** | String (ISO 8601 timestamp) |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Optional start date for backfilling ETL data.

```bash
ETL_BACKFILL_FROM=2024-01-01T00:00:00Z
```

### ETL_BACKFILL_TO

| Property | Value |
|----------|-------|
| **Type** | String (ISO 8601 timestamp) |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Optional end date for backfilling ETL data.

```bash
ETL_BACKFILL_TO=2024-01-31T23:59:59Z
```

---

## Metrics & Monitoring

### METRICS_TOKEN

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | ✅ **Yes** — bearer token for Prometheus access |

Bearer token required to access the `/metrics` endpoint (Prometheus scraper).

```bash
METRICS_TOKEN=your-secure-metrics-token-here
```

If set, requests to `/metrics` must include `Authorization: Bearer $METRICS_TOKEN`.

### METRICS_ALLOWLIST

| Property | Value |
|----------|-------|
| **Type** | String (comma-separated metric names or patterns) |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Optional allowlist of metric names/patterns to expose. If set, only matching metrics are returned.

```bash
METRICS_ALLOWLIST=disciplr_*,process_*
```

---

## Security Thresholds

These variables control abuse detection and rate limiting. Adjust based on threat model and traffic patterns.

### SECURITY_RATE_LIMIT_WINDOW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `60000` |
| **Required** | No |
| **Sensitive** | No |

Time window for general rate limiting.

```bash
SECURITY_RATE_LIMIT_WINDOW_MS=60000
```

### SECURITY_RATE_LIMIT_MAX_REQUESTS

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `120` |
| **Required** | No |
| **Sensitive** | No |

Maximum requests allowed per client per window.

```bash
SECURITY_RATE_LIMIT_MAX_REQUESTS=100
```

### SECURITY_SUSPICIOUS_WINDOW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `300000` |
| **Required** | No |
| **Sensitive** | No |

Time window for suspicious activity detection (5 minutes by default).

```bash
SECURITY_SUSPICIOUS_WINDOW_MS=300000
```

### SECURITY_SUSPICIOUS_404_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `20` |
| **Required** | No |
| **Sensitive** | No |

Threshold for 404 errors per client within the suspicious window before alerting.

```bash
SECURITY_SUSPICIOUS_404_THRESHOLD=30
```

### SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `12` |
| **Required** | No |
| **Sensitive** | No |

Threshold for distinct paths accessed per client before flagging as suspicious.

```bash
SECURITY_SUSPICIOUS_DISTINCT_PATH_THRESHOLD=15
```

### SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `30` |
| **Required** | No |
| **Sensitive** | No |

Threshold for 400 errors per client before flagging as suspicious.

```bash
SECURITY_SUSPICIOUS_BAD_REQUEST_THRESHOLD=40
```

### SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `300` |
| **Required** | No |
| **Sensitive** | No |

Threshold for total requests per client before flagging as high-volume suspicious activity.

```bash
SECURITY_SUSPICIOUS_HIGH_VOLUME_THRESHOLD=500
```

### SECURITY_FAILED_LOGIN_WINDOW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `900000` |
| **Required** | No |
| **Sensitive** | No |

Time window for tracking failed login attempts (15 minutes by default).

```bash
SECURITY_FAILED_LOGIN_WINDOW_MS=900000
```

### SECURITY_FAILED_LOGIN_BURST_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `5` |
| **Required** | No |
| **Sensitive** | No |

Number of failed logins per account before triggering account lockout or alert.

```bash
SECURITY_FAILED_LOGIN_BURST_THRESHOLD=3
```

### SECURITY_ALERT_COOLDOWN_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `300000` |
| **Required** | No |
| **Sensitive** | No |

Cooldown between security alerts for the same client/event type.

```bash
SECURITY_ALERT_COOLDOWN_MS=600000
```

### ORG_RATE_LIMIT_MAX

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `200` |
| **Required** | No |
| **Sensitive** | No |

Organization-level rate limit ceiling.

```bash
ORG_RATE_LIMIT_MAX=300
```

### ORG_RATE_LIMIT_WINDOW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `60000` |
| **Required** | No |
| **Sensitive** | No |

Time window for organization-level rate limiting.

```bash
ORG_RATE_LIMIT_WINDOW_MS=60000
```

### EXPORT_DAILY_QUOTA_LIMIT

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `100` |
| **Required** | No |
| **Sensitive** | No |

Maximum daily exports per organization.

```bash
EXPORT_DAILY_QUOTA_LIMIT=500
```

---

## Scheduled Jobs

### DEADLINE_CHECK_INTERVAL_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `60000` |
| **Required** | No |
| **Sensitive** | No |

Interval for checking vault deadlines (1 minute by default).

```bash
DEADLINE_CHECK_INTERVAL_MS=120000
```

### ANALYTICS_RECOMPUTE_INTERVAL_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `300000` |
| **Required** | No |
| **Sensitive** | No |

Interval for recomputing analytics data (5 minutes by default).

```bash
ANALYTICS_RECOMPUTE_INTERVAL_MS=600000
```

---

## Webhooks

### WEBHOOK_INBOUND_SECRET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | ✅ **Yes** — used to verify webhook signatures |

Secret for verifying inbound webhook signatures.

```bash
WEBHOOK_INBOUND_SECRET=your-webhook-secret-here
```

### WEBHOOK_INBOUND_SKEW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `300000` |
| **Required** | No |
| **Sensitive** | No |

Allowed timestamp skew for webhook signature verification (5 minutes by default).

```bash
WEBHOOK_INBOUND_SKEW_MS=300000
```

### WEBHOOK_CIRCUIT_BREAKER_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Positive integer |
| **Default** | `5` |
| **Required** | No |
| **Sensitive** | No |

Number of consecutive failed webhook deliveries before opening the circuit breaker.

```bash
WEBHOOK_CIRCUIT_BREAKER_THRESHOLD=3
```

### WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `60000` |
| **Required** | No |
| **Sensitive** | No |

Sliding window for failure counting in the circuit breaker (1 minute by default).

```bash
WEBHOOK_CIRCUIT_BREAKER_WINDOW_MS=60000
```

### WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `30000` |
| **Required** | No |
| **Sensitive** | No |

Time to wait before transitioning from OPEN to HALF_OPEN state.

```bash
WEBHOOK_CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS=60000
```

---

## Exports & S3

### EXPORT_S3_BUCKET

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | Conditional — required if exporting to S3 |
| **Sensitive** | No |

AWS S3 bucket name for storing exports.

```bash
EXPORT_S3_BUCKET=my-disciplr-exports
```

### EXPORT_S3_REGION

| Property | Value |
|----------|-------|
| **Type** | String |
| **Default** | *(none)* |
| **Required** | Conditional — required if exporting to S3 |
| **Sensitive** | No |

AWS region for the S3 bucket.

```bash
EXPORT_S3_REGION=us-west-2
```

### EXPORT_SIGNED_URL_TTL_S

| Property | Value |
|----------|-------|
| **Type** | Positive integer (seconds) |
| **Default** | `3600` |
| **Required** | No |
| **Sensitive** | No |

Time-to-live (TTL) for signed S3 URLs (1 hour by default).

```bash
EXPORT_SIGNED_URL_TTL_S=7200
```

---

## Logging

### MAX_JSON_BODY_SIZE

| Property | Value |
|----------|-------|
| **Type** | String |
| **Valid Units** | `b`, `kb`, `mb`, `gb` |
| **Default** | `500kb` |
| **Required** | No |
| **Sensitive** | No |

Maximum request body size for JSON payloads.

```bash
MAX_JSON_BODY_SIZE=1mb
```

### HORIZON_LAG_THRESHOLD

| Property | Value |
|----------|-------|
| **Type** | Non-negative integer |
| **Default** | `10` |
| **Required** | No |
| **Sensitive** | No |

Threshold (in ledgers) to warn if Horizon is lagging behind the network.

```bash
HORIZON_LAG_THRESHOLD=5
```

### HORIZON_SHUTDOWN_TIMEOUT_MS

| Property | Value |
|----------|-------|
| **Type** | Positive integer (milliseconds) |
| **Default** | `30000` |
| **Required** | No |
| **Sensitive** | No |

Graceful shutdown timeout for the Horizon listener.

```bash
HORIZON_SHUTDOWN_TIMEOUT_MS=45000
```

### CORS_ORIGINS

| Property | Value |
|----------|-------|
| **Type** | String (comma-separated URLs or `*`) |
| **Default** | *(none)* |
| **Required** | No |
| **Sensitive** | No |

Allowed cross-origin request origins. Each must be a valid `http://` or `https://` URL.

```bash
CORS_ORIGINS=https://app.example.com,https://admin.example.com
CORS_ORIGINS=*
```

> ⚠️ **Production Warning:** Avoid `CORS_ORIGINS=*` unless necessary. It allows every origin to access your API.

---

## Security Guidelines

### Secret Management Best Practices

1. **Never Commit Secrets:** `.env` and `.env.local` are in `.gitignore` — do not commit them.

2. **Use Environment-Specific Vaults:** In production, use:
   - AWS Secrets Manager
   - HashiCorp Vault
   - Azure Key Vault
   - Google Cloud Secret Manager

3. **Rotation:** Rotate secrets periodically:
   - `JWT_*_SECRET`: Use `JWT_KEYS` for seamless key rotation.
   - Database passwords: Rotate via your database provider.
   - Soroban secret key: Re-deploy to a new key if compromised.

4. **Audit Logging:** Enable audit logging for secret access in your vault.

5. **Principle of Least Privilege:** Grant only required permissions to service accounts accessing secrets.

### Detecting Misconfigurations

The application validates at startup and logs warnings for common issues:

- **Insecure Defaults in Production:** If any `*_SECRET` uses its default value in `NODE_ENV=production`, a warning is logged.
- **Partial Soroban Configuration:** If some but not all Soroban submit-mode variables are set, submit mode is disabled and a warning is logged.
- **HTTP Timeout Misalignment:** If `HTTP_KEEPALIVE_TIMEOUT_MS >= HTTP_HEADERS_TIMEOUT_MS` or similar, validation fails at startup.
- **CORS Misconfiguration:** `CORS_ORIGINS=*` in production triggers a hard validation error.

Check logs for `level: "warn"` or `level: "fatal"` events to catch misconfigurations early.

---

## Example Configurations

### Local Development

```bash
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://postgres:postgres@localhost:5432/disciplr
REDIS_URL=redis://localhost:6379
JWT_SECRET=dev-secret-key-at-least-16-chars
JWT_ACCESS_SECRET=dev-access-secret-key
JWT_REFRESH_SECRET=dev-refresh-secret-key
DOWNLOAD_SECRET=dev-download-secret
LOG_LEVEL=debug
CORS_ORIGINS=http://localhost:3000,http://localhost:3001
```

### Production (Stellar Testnet)

```bash
NODE_ENV=production
PORT=8080
DATABASE_URL=postgresql://prod_user:${DB_PASSWORD}@prod.db.example.com:5432/disciplr
REDIS_URL=rediss://redis.example.com:6380
JWT_SECRET=${JWT_SECRET_PROD}
JWT_ACCESS_SECRET=${JWT_ACCESS_SECRET_PROD}
JWT_REFRESH_SECRET=${JWT_REFRESH_SECRET_PROD}
DOWNLOAD_SECRET=${DOWNLOAD_SECRET_PROD}
LOG_LEVEL=info
CORS_ORIGINS=https://app.example.com,https://admin.example.com
HORIZON_URL=https://horizon-testnet.stellar.org
SOROBAN_CONTRACT_ID=CDISCIPLR...
SOROBAN_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
SOROBAN_SOURCE_ACCOUNT=GAAAA...
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_SECRET_KEY=${SOROBAN_SECRET_KEY_PROD}
ENABLE_JOB_SCHEDULER=true
ENABLE_ETL_WORKER=true
METRICS_TOKEN=${METRICS_TOKEN_PROD}
EXPORT_S3_BUCKET=my-disciplr-exports-prod
EXPORT_S3_REGION=us-west-2
```

### Production (Stellar Mainnet)

```bash
NODE_ENV=production
# ... same as testnet above, but:
HORIZON_URL=https://horizon.stellar.org
SOROBAN_NETWORK_PASSPHRASE=Public Global Stellar Network ; September 2015
SOROBAN_RPC_URL=https://soroban.stellar.org
```

---

## Validation & Testing

Every variable is validated against the schema in `src/config/env.ts` at application startup. To test local configurations:

```bash
# Run validation with a custom .env file
ls -la .env
npm run validate:env

# Or programmatically in tests:
import { validateEnv } from 'src/config/env';
const { env, warnings } = validateEnv({ NODE_ENV: 'test', DATABASE_URL: '...' });
```

---

## References

- **Validator Source:** [src/config/env.ts](../src/config/env.ts)
- **Example File:** [.env.example](.env.example)
- **Database Docs:** [docs/database-migrations.md](./database-migrations.md)
- **API Patterns:** [docs/API_PATTERNS.md](./API_PATTERNS.md)
- **Audit Logging:** [docs/audit-logging.md](./audit-logging.md)
