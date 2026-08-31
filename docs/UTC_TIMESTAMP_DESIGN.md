# UTC timestamp design

This document records the timestamp contract implemented for issue #1507.
Vault deadlines are business decisions, so a timestamp must identify one
instant regardless of the timezone of the client, API process, database driver,
worker, or verifier.

## Contract

The backend accepts ISO 8601 date-time values only when they include an
explicit timezone designator:

- `Z` means UTC.
- `+HH:MM` and `-HH:MM` identify a numeric offset from UTC.
- A timezone-less wall-clock value is rejected as ambiguous.
- Date-only strings, locale-formatted strings, and named zones are rejected at
  request boundaries.

Accepted input is normalized immediately to an ISO string ending in `Z` before
it reaches persistence or downstream services. API responses also use the
canonical `Z` form. Display clients may render that instant in a user-selected
zone, but that presentation must not be written back as a deadline without an
explicit offset.

## Why explicit offsets are required

The string `2026-11-01T01:30:00` occurs twice in New York when daylight saving
time ends. A process that interprets it using its local timezone cannot know
which occurrence a client intended. Requiring `-04:00` or `-05:00` makes the
two instants distinct. The same rule also avoids behavior changing when a
container moves between regions or when `TZ` differs between test and
production.

The offset is part of the input's meaning; it is not metadata that can be
discarded before conversion. Once normalized, comparisons use the UTC instant,
not the original wall-clock components.

## Validation pipeline

The pipeline is shared by vault creation, milestone creation, and timestamp
utility consumers:

1. Confirm the value is a string or a valid database `Date` object.
2. Match the exact ISO date-time shape.
3. Require `Z` or a numeric offset.
4. Check hour, minute, second, and offset ranges.
5. Check the real calendar day for the supplied year and month.
6. Let the runtime parse the complete instant and reject an invalid result.
7. Convert to a UTC ISO string with millisecond precision.
8. Persist and serialize only that canonical value.

The calendar check is independent of the host timezone. This matters for
February 29, years near the epoch, and processes running west or east of UTC.
The implementation handles Gregorian leap-year rules, including the century
exception, rather than relying on date rollover behavior.

## Persistence boundaries

PostgreSQL `TIMESTAMPTZ` values represent instants, but database drivers may
return them as `Date` objects or strings depending on query path and adapter.
The vault store normalizes both forms while mapping rows to the application
model. This keeps the response contract stable even when a row was written by
an older process or read through a different driver path.

The following values are normalized before leaving the store:

| Source field | Public field |
| --- | --- |
| `start_date` | `startDate` / `startTimestamp` |
| `end_date` | `endDate` / `endTimestamp` |
| `due_date` | `dueDate` |
| `created_at` | `createdAt` |
| `updated_at` | `updatedAt` |

New vault and milestone input has already passed through the Zod transform, so
the write path receives canonical strings. The mapping guard remains in place
for existing rows and direct store callers.

## Deadline comparisons

Deadline code converts every persisted timestamp through `toUTCDate` before
comparison. It never compares localized strings and never relies on a process
default timezone. Equality is a real boundary:

- `endDate > now`: the vault remains active.
- `endDate === now`: the deadline has been reached.
- `endDate < now`: the vault is eligible for expiration.

The expiration scheduler, milestone reminder service, and in-memory transition
compatibility path use the same conversion rule. A malformed persisted date
raises an explicit timestamp error instead of silently becoming `NaN`, epoch,
or an immediately expired record.

Reminder payloads are normalized before notification creation. Therefore a
worker that reads a database value with a driver-specific representation still
publishes the same `dueDate` value as the API.

## API behavior

Create and milestone schemas return a typed validation failure for a missing
timezone, malformed date, impossible calendar date, or invalid offset. The
normalized result is the value passed to the store. Clients can therefore use
the response value as a stable cursor or send it to another service without
carrying the original local timezone.

Organization vault list endpoints apply the same output normalization. Query
date filters also require explicit timezone-bearing ISO values. This prevents a
filter such as “midnight” from selecting different rows depending on where the
API worker is running.

## DST and calendar examples

The following values are different local representations of the same instant:

```text
2026-01-15T12:00:00-05:00
2026-01-15T17:00:00Z
2026-01-15T22:30:00+05:30
```

They normalize to:

```text
2026-01-15T17:00:00.000Z
```

At the 2026 New York daylight-saving transition, these are adjacent instants:

```text
2026-03-08T01:59:59-05:00
2026-03-08T03:00:00-04:00
```

The wall clock jumps by an hour, but the UTC instants are one second apart.
Deadline and accrual code must use this instant difference.

At the fall transition, the repeated local hour is disambiguated by its offset:

```text
2026-11-01T01:30:00-04:00 -> 2026-11-01T05:30:00.000Z
2026-11-01T01:30:00-05:00 -> 2026-11-01T06:30:00.000Z
```

## Compatibility and limitations

The public contract supports numeric offsets, not IANA zone names. A client
that starts with `America/New_York` must resolve the zone for the intended
local date and send the resulting numeric offset. This avoids requiring the
backend to guess historical or future timezone rules.

Existing database values are accepted when the driver returns a valid `Date`
object or a strict timezone-bearing string. A legacy row that cannot be
normalized is surfaced as an explicit error and should be repaired through a
data migration; it is not silently changed to a different instant.

Formatting is presentation-only. `formatTimestamp` defaults to UTC and accepts
an explicit IANA timezone for emails or reports. Formatting never changes the
stored value.

## Test evidence

`src/utils/timestamps.test.ts` covers:

- timezone-less and malformed values;
- invalid offset ranges;
- impossible dates and leap-year century rules;
- DST spring-forward and fall-back transitions;
- negative and positive epoch edges;
- database `Date` round trips;
- UTC day boundaries;
- schema normalization and rejection;
- stable API formatting.

Run the focused suite with:

```text
pnpm exec jest src/utils/timestamps.test.ts --runInBand
```

Run all repository tests with:

```text
pnpm test --runInBand
```

The full test command may require the repository's configured database test
environment. The focused suite has no network or database dependency and is
safe to run in isolation.
