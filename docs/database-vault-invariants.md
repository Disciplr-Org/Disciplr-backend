# Vault database invariants

Issue #1503 hardens the database contract for vault identity, lifecycle state,
verifier assignment, milestone ordering, and transaction history. The change is
implemented in `20260827000000_harden_vault_invariants.cjs`.

## Invariants

The migration protects the following rules at the database boundary:

| Area                | Rule                                               | Database protection                |
| ------------------- | -------------------------------------------------- | ---------------------------------- |
| Vault identity      | IDs are present and non-empty                      | `ck_vaults_id_nonempty`            |
| Vault amount        | Amount cannot be negative                          | `ck_vaults_amount_nonnegative`     |
| Lifecycle           | Start is not after end                             | `ck_vaults_date_order`             |
| Verifier            | Every persisted vault has an assignment            | `ck_vaults_verifier_nonempty`      |
| Milestone amount    | Amount cannot be negative                          | `ck_milestones_amount_nonnegative` |
| Milestone ordering  | Sort position is non-negative and unique per vault | check plus unique constraint       |
| Milestone verifier  | Optional assignment cannot be blank                | `ck_milestones_verifier_nonempty`  |
| Approval threshold  | M-of-N threshold is at least one                   | `ck_milestones_threshold_positive` |
| Transactions        | Amount and Stellar ledger are non-negative         | two transaction checks             |
| Transaction linkage | Vault ID is non-empty and references a vault       | check plus existing FK             |

These checks are intentionally narrow. They do not change the vault status
enum, API payloads, application transition rules, or deployment configuration.

## Existing data and rollout safety

The migration starts with read-only preflight queries. It counts every known
violation, including duplicate `(vault_id, sort_order)` pairs and orphaned
transaction links. If any count is non-zero, the migration throws one concise
error listing the categories and stops before adding a constraint or index.

Operators should remediate the reported rows in a separately reviewed data
migration, then retry this migration. The hardening migration does not silently
rewrite, delete, or invent business data. This keeps the rollout auditable and
prevents a partially corrected state from being mistaken for valid data.

The preflight checks use the same predicates as the eventual constraints. This
means a clean preflight proves that `VALIDATE CONSTRAINT` will not discover an
unexpected legacy violation. The migration still validates each check after
adding it, so concurrent writes cannot bypass the final database contract.

## Online index strategy

The four new query indexes are created with `CREATE INDEX CONCURRENTLY` and the
migration explicitly opts out of Knex's transaction wrapper. Concurrent index
builds reduce write blocking on production tables. The new indexes cover:

- creator/status/created-at vault listing and cursor queries;
- verifier/status/end-date lifecycle processing;
- vault/status/due-date milestone dashboards; and
- vault/type/ledger transaction history.

Existing single-column indexes are retained. The new indexes are additive and
are named explicitly so `pg_indexes` and query-plan reviews can verify them.
The descending columns support newest-first access without an in-memory sort.

## Concurrency and uniqueness

Milestone positions are first checked for duplicates, then protected with an
online unique index on `(vault_id, sort_order)`. The index is attached to a
named unique constraint after it is built. The uniqueness check happens inside
PostgreSQL, so two concurrent inserts cannot claim the same position even if
both requests pass application-level validation.

The existing primary key continues to protect vault identity, while the new
non-empty check closes the gap for malformed text identifiers in imported or
legacy rows. The existing foreign key on `transactions.vault_id` remains the
authoritative linkage rule; the new preflight detects orphaned data before the
new contract is considered complete.

## Rollback

`down` removes the unique constraint, all eleven checks, and the four additive
indexes. It handles the unusual case where a concurrent unique index exists but
has not yet been attached. It does not drop or recreate application tables and
does not mutate row data.

The migration rollback test suite continues to exercise full up/down/re-up
cycles. The focused migration contract tests additionally verify that every
new object is named in both directions, that the preflight precedes schema
changes, and that concurrent index syntax is present.

## Validation and limitations

The focused tests validate migration structure and safety without requiring a
developer database. In an environment with PostgreSQL, operators should also
run `EXPLAIN (ANALYZE, BUFFERS)` for representative creator, verifier,
milestone, and transaction queries and confirm the new index names appear in
the plan. Query plans depend on table cardinality and statistics, so the
migration cannot guarantee a particular planner choice for every dataset.

The migration intentionally fails on dirty existing data rather than guessing
how to repair it. That is the safest behavior for financial and audit-linked
records, but it means a deployment with legacy violations needs a reviewed
remediation step before this migration can be applied.
