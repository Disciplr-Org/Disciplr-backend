# Verifier queue authorization

Verifier actions are authorization-sensitive state transitions. The actor in
the signed authentication principal is the only identity used for the check;
wallet headers, request body fields, and role-shaped client headers are not
trusted as assignment evidence.

## Decision table

| Action | Queue shape | Required assignment | Result when stale or missing |
| --- | --- | --- | --- |
| `verify` | single verifier | exact current `verifierId` | `403`, no mutation |
| `validate` | single verifier | exact current `verifierId` | `403`, no mutation |
| `approve` | single verifier | exact current `verifierId` | `403`, no mutation |
| `approve` | M-of-N | approved verifier pool | `403` for non-approved/suspended actor |

The M-of-N exception is intentional. `verifierId` identifies the queue
coordinator, while individual approvals come from the configured approved
verifier pool. M-of-N does not broaden `verify` or single-verifier
`validate`.

## Authorization boundary

`authorizeVerifierQueueAction` is a pure guard in
`src/services/verifierTransitions.ts`. It is called before mutation and
before any external side effect. It distinguishes these stable failure
codes:

- `ACTOR_REQUIRED`: the request has no authenticated actor;
- `UNASSIGNED_QUEUE_ITEM`: no current verifier owns the item;
- `STALE_ASSIGNMENT`: the item was reassigned after the actor received it;
- `ALREADY_SETTLED`: a terminal item is being verified or validated again;
- `INVALID_TRANSITION`: the requested lifecycle edge is not monotonic.

The guard does not accept a proposed assignee from the request. A reassignment
therefore invalidates an old queue response immediately, even if that old
response is replayed with a fresh HTTP request.

## Atomicity and auditability

Routes perform the guard before changing the compatibility in-memory milestone
record or inserting an approval. The lifecycle service performs the same
guard when an actor is supplied, so direct service callers cannot skip the
authorization boundary. Failed guards do not increment the lifecycle
sequence, set `verified`, insert an approval, or emit a success event.

Every successful state-changing path emits one ordered milestone event:

1. `milestone.verified` for the direct verification endpoint;
2. `milestone.validated` for evidence-backed validation;
3. `milestone.approval.recorded` for each approval vote;
4. `milestone.settled` when the approval threshold settles the milestone;
5. `milestone.lifecycle.*` for explicit lifecycle transitions.

The event ledger is append-only for the process lifetime, has a monotonically
increasing per-milestone sequence, and is reset only by test fixtures. This
makes the order of accepted state changes observable without exposing
evidence hashes or other sensitive values.

## Operational trade-offs

The compatibility milestone service remains synchronous because existing
clients and tests depend on its in-memory representation. The authorization
guard is deliberately synchronous and side-effect-free for that reason. The
database-backed approval insert still uses its unique constraint as the final
concurrency barrier; the route-level guard supplies the authorization barrier
before that insert. A future database-native queue consumer should call the
same guard after selecting the row with a transaction lock and include its
audit insert in the transaction.

## Test matrix

The regression suite covers:

- current assignee success for all single-verifier actions;
- missing actor and unassigned queue item failures;
- stale actor failures after reassignment;
- M-of-N approval-pool behavior;
- settled-item rejection;
- all permitted lifecycle edges;
- backward, self, and skipped lifecycle transitions;
- stable machine-readable error details.

