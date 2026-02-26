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

## Server-side utilities

All timestamp operations are centralized in `src/utils/timestamps.ts`:

| Function | Purpose |
|----------|---------|
| `utcNow()` | Returns current time as ISO 8601 UTC string |
| `isValidISO8601(value)` | Validates format + timezone + calendar correctness |
| `parseAndNormalizeToUTC(value)` | Converts any offset to UTC `Z` |
| `formatTimestamp(iso, options?)` | Localized formatting via `Intl.DateTimeFormat` |

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
