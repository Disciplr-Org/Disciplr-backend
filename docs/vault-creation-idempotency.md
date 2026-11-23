# Vault creation idempotency

`POST /api/vaults` accepts an `idempotency-key` so clients can safely retry a
request after a timeout. A key is a durable reservation, not merely a cache
entry. The reservation owns the request fingerprint, authenticated owner,
pending/completed state, expiry, vault ID, and final response.

## Transaction boundary

When PostgreSQL is available, one transaction contains:

1. the unique reservation insert or locked existing-row read;
2. vault creation;
3. milestone creation;
4. response finalization;
5. the commit.

The unique key means concurrent first requests cannot both claim the work. The
second transaction waits for the first transaction's row lock, then replays
the stored response after commit. If creation fails, the transaction rolls
back and no partially created vault or completed reservation remains.

The development-only in-memory fallback uses a mutex and removes a claim when
the callback fails. It is not restart durable; production startup should keep
PostgreSQL enabled and should alert when fallback logging appears.

## Ownership and fingerprints

The key is bound to the authenticated user and organization. A different
owner receives `IDEMPOTENCY_OWNER_MISMATCH`, even when the request body hash is
identical. The same owner using a different request fingerprint receives
`IDEMPOTENCY_CONFLICT`. Neither error creates a side effect.

The fingerprint is computed from the original request body before creation.
Clients must send the same canonical JSON values when retrying. The final
response is persisted as JSON and returned byte-for-byte at the semantic JSON
level; on-chain payload construction is not repeated for a replay.

## Expiry

Completed entries remain available for the configured retention period used by
the idempotency policy. A pending entry can be reclaimed only after its expiry
time and only by the same owner and request fingerprint. Reclamation keeps the
original identity fields immutable, so expiry cannot be used to transfer a
key between users. Operators should size the TTL above the maximum expected
request duration plus the client retry window.

An in-progress request returns HTTP 409 with a retryable error when a caller
observes an unexpired pending reservation. A client should wait and retry the
same key, not create a new key that could produce a duplicate vault.

## Failure and recovery matrix

| Condition | Response | Side effect |
| --- | --- | --- |
| first request succeeds | 201 | one vault and one completed reservation |
| exact retry after success | 200 | stored response only |
| same key, changed body | 409 conflict | none |
| same key, different owner | 409 owner mismatch | none |
| concurrent first request | 200 replay or 409 in-progress | at most one vault |
| storage failure before commit | 500 | transaction rolls back |
| expired pending reservation | retry claims original owner/fingerprint | one new attempt |
| database unavailable in development | memory fallback warning | not restart durable |

## Operational checks

Monitor pending reservations by age, conflict counts by owner, creation
rollback counts, and the ratio of replayed to new responses. A growing pending
age indicates a crashed worker or a database transaction that is not closing.
Never log request bodies, response payloads, or secrets in the metrics path;
the key hash, owner scope, vault ID, and status code are sufficient.

The migration creates indexes for expiry cleanup and owner-scoped support
queries. Cleanup must delete only completed rows past the documented retention
period and pending rows past a separately reviewed recovery window. Deletion
of a pending row is an operational action because it may permit a retry to
start after an uncertain client timeout.

## Test expectations

Regression coverage includes exact replay, changed fingerprint, owner mismatch,
concurrent first writes, callback/storage failure, anonymous isolation, and
opaque response replay. PostgreSQL integration tests should additionally run
two clients against the same key, kill the first transaction before commit,
verify rollback, and retry after expiry. The key invariant is:

```text
one (owner, request_hash, idempotency_key) -> zero or one vault
```

The response may be returned many times, but the vault creation callback may
successfully commit only once for a live reservation.
