# Timezone Contract

This document defines how Disciplr handles timestamps across the stack.

## Core principles

1. **Storage**: All timestamps are stored in UTC using `TIMESTAMPTZ` columns in PostgreSQL.
2. **Input**: Clients must send ISO 8601 strings with a timezone designator (`Z` or `±HH:MM`). Timestamps without timezone are rejected with HTTP 400.
3. **Normalization**: The server normalizes all incoming offsets to UTC (`Z`) before storage.
4. **Output**: All API responses return timestamps in UTC ending with the `Z` suffix.
5. **Header**: Every HTTP response includes `X-Timezone: UTC` to signal the timezone policy.

## Input validation

The `endTimestamp` field on `POST /api/vaults` is validated as follows:

| Check | Error |
|-------|-------|
| Missing timezone (`2025-06-15T12:00:00`) | 400 — must include timezone |
| Invalid format (`next tuesday`) | 400 — must be ISO 8601 |
| Impossible date (`2025-02-30T00:00:00Z`) | 400 — invalid date |
| Past date | 400 — must be future |

## Request examples

### Valid payloads (timezone required)

```json
{
  "startDate": "2026-06-01T09:00:00Z",
  "endDate": "2026-06-30T17:00:00+02:00",
  "milestones": [
    {
      "title": "Kickoff",
      "dueDate": "2026-06-07T12:00:00-04:00",
      "amount": "100"
    }
  ]
}
```

### Invalid payloads (missing timezone)

```json
{
  "endDate": "2026-06-30T17:00:00"
}
```

Expected error excerpt:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "fields": [
      {
        "path": "endDate",
        "message": "must include timezone (Z or +/-HH:MM)"
      }
    ]
  }
}
```

## Server-side utilities

All timestamp operations are centralized in `src/utils/timestamps.ts`:

| Function | Purpose |
|----------|---------|
| `utcNow()` | Returns current time as ISO 8601 UTC string |
| `isValidISO8601(value)` | Validates format + timezone + calendar correctness |
| `parseAndNormalizeToUTC(value)` | Converts any offset to UTC `Z` |
| `formatTimestamp(iso, options?)` | Localized formatting via `Intl.DateTimeFormat` |

## Deadline transitions

Vault deadline checks compare the stored `end_date` timestamp against the current UTC instant. The scheduler, `deadline.check` job handler, and service-level vault expiry path share `markVaultExpiries()` so boundary behavior stays consistent.

| Case | Example at `now = 2026-04-25T12:00:00.000Z` | Result |
|------|---------------------------------------------|--------|
| Just before deadline | `end_date = 2026-04-25T12:00:00.001Z` | Stays active |
| Exactly at deadline | `end_date = 2026-04-25T12:00:00.000Z` | Fails |
| Just after deadline | `end_date = 2026-04-25T11:59:59.999Z` | Fails |

Offset timestamps are normalized by JavaScript `Date` parsing before comparison, so `2026-04-25T07:59:59.999-04:00` is treated as `2026-04-25T11:59:59.999Z`. Repeated deadline checks are idempotent because only `active` vaults are eligible for transition. The interval scheduler applies the shared comparison in batches of 50 vaults per tick.

## Frontend guidance

Frontends should:

- Store and transmit timestamps in UTC (as returned by the API)
- Convert to the user's local timezone for display using `Intl.DateTimeFormat`:

```javascript
const display = new Intl.DateTimeFormat('es-AR', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}).format(new Date(vault.endTimestamp))
```

## Server-side localization hook

For emails, PDF reports, or other server-rendered content, use `formatTimestamp()`:

```typescript
import { formatTimestamp } from './utils/timestamps.js'

const localized = formatTimestamp(vault.endTimestamp, {
  locale: 'es-AR',
  timeZone: 'America/Argentina/Buenos_Aires',
  style: 'long',
})
```

No external date libraries are needed — `Intl.DateTimeFormat` is built into Node.js.
