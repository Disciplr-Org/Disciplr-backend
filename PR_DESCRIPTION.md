# [Quality] Improve milestone lifecycle and event ordering: regression, accessibility, and compatibility coverage

Closes #1525

---

## Summary

This PR establishes a durable regression, accessibility, and compatibility contract for the milestone lifecycle and event-ordering feature anchored at `src/routes/milestones.ts` and `src/repositories/milestoneRepository.ts`. It does three things:

1. **Restores the milestone/webhook/verifier code to a compiling, CI-passing state.** Multiple recent commits left the tree broken: `src/routes/milestones.ts` referenced milestone-service functions without importing them, its vault-ownership check read non-existent `PersistedVault` fields, `src/middleware/webhookVerify.ts` was corrupted with two merged verification bodies, and `src/routes/milestones.idempotency.test.ts` was committed with invalid template-literal syntax.
2. **Reinstates the adversarial-input invariants** (#1560's hostile-input guards in `src/services/verifiers.ts`) that a later refactor (#1565) silently dropped — milestone approvals and veto progress must reject malformed identifiers/statuses and clamp degenerate thresholds.
3. **Adds the focused automated coverage the issue calls for**: 31 new route-level integration tests covering success/failure/empty/retry/permission states across all six milestone endpoints, plus 5 new unit tests for event-ledger ordering boundaries, and a documented regression + authorization contract in `docs/milestones.md`.

**Status of the milestone lifecycle feature:** the monotonic state machine (`created → submitted → validated → settled`), the ordered append-only event ledger with `m_<seq>_<suffix>` ids, per-milestone idempotency keys, multi-verifier approval with veto math, and the route-level authorization boundaries are all now pinned by automated tests. The accessibility criteria are N/A for this feature (server-side JSON API — no interactive UI exists in this repository); the API-level equivalent — a stable machine-readable error contract — is covered by the route tests.

---

## Background / Problem

The milestone lifecycle implementation had drifted since its original hardening commits. Concretely, on `main` at the time of this PR:

| # | Defect | Introduced by | Symptom |
|---|---|---|---|
| 1 | `src/routes/milestones.ts` calls `createMilestoneWithThreshold`, `getMilestoneById`, `verifyMilestone`, `validateMilestone`, `allMilestonesVerified`, `getMilestonesByVaultId`, `allMilestonesMetThreshold` **without importing them** (the `../services/milestones.js` import was deleted) | #1565 (`27d0d1b`) | `tsc` failure: `TS2304: Cannot find name ...` ×8; at runtime the handlers would throw `ReferenceError` |
| 2 | Vault-ownership check reads `vault.ownerId` / `vault.organizationId`, which **do not exist** on `PersistedVault` (real fields: `creator`, `orgId`) | #1567 (`1603efb`) | `tsc` failure: `TS2339` ×2; at runtime every vault creator would have been denied (`undefined === userId` → always 403) |
| 3 | `recordMilestoneApproval` lost its empty/whitespace/non-string identifier validation and `approvalStatus` allow-list; `getMilestoneApprovalProgress` lost its threshold/`totalVerifiers` clamping | #1565 (`27d0d1b`) | `tests/multiVerifier.veto.test.ts` hostile-input suite fails (12 tests) |
| 4 | `src/middleware/webhookVerify.ts` corrupted: old verification body pasted in place of the `record` telemetry helper, duplicate `nonceCache`/`pendingNonces` `Set` declarations conflicting with the `BoundedReplayStore` instances, `WebhookVerifyOutcome` type deleted, `validateWebhookBody` boundary check orphaned in the dead body | #1571 (`aba37b8`) | `tsc` failure: `TS1005`/`TS1128`; the hardening/boundary suites could not even load |
| 5 | `src/routes/milestones.idempotency.test.ts` contains literal `\`` (backslash-backtick) instead of a template literal | #1567 (`1603efb`) | `TS1127: Invalid character` / `TS1160: Unterminated template literal` — the suite never ran |

Defects 1, 2, and 4 mean **`npm run build` (a CI gate) failed on `main`**, and the milestone/webhook test suites could not execute. This PR fixes all five and adds the coverage that makes the milestone lifecycle contract durable.

---

## Changes

### 1. Regression fixes — `src/routes/milestones.ts`

- **Restored the `../services/milestones.js` import** (`createMilestoneWithThreshold`, `getMilestonesByVaultId`, `getMilestoneById`, `verifyMilestone`, `validateMilestone`, `allMilestonesVerified`, `allMilestonesMetThreshold`).
- **Fixed the ownership check** to use the real vault fields, mirroring the ownership model in `src/routes/vaults.ts`:
  ```ts
  const isOwner = (owner.userId && vault.creator === owner.userId) ||
                  (owner.orgId && vault.orgId === owner.orgId) ||
                  req.user?.role === UserRole.ADMIN;
  ```
  A vault's creator, an org-scoped principal whose org matches `vault.orgId`, or an `ADMIN` may manage the vault's milestones; everyone else gets `403`. This restores the intent of #1567's "caller must own this vault" boundary.
- Removed two unused imports (`randomUUID`, `MilestoneStatus`).

### 2. Regression fixes — `src/services/verifiers.ts` (adversarial-input invariants)

Restored the hostile-input boundary from #1560 that #1565 accidentally reverted:

- **`recordMilestoneApproval`** now rejects empty/whitespace-only/non-string `milestoneId` and `verifierUserId` **before** entering the transaction, and rejects any `approvalStatus` other than `approved`/`rejected`. Malformed votes can never be written to `milestone_approvals`.
- **`getMilestoneApprovalProgress`** now clamps the threshold to a sane range:
  - `safeThreshold = max(1, floor(Number(approvalThreshold) || 1))` — zero, negative, and `NaN` thresholds cannot produce a degenerate "complete" verdict.
  - `safeTotal` is only used when `totalVerifiers > 0`; otherwise the legacy mode applies (any rejection vetoes). Negative/zero `totalVerifiers` cannot corrupt veto math.

### 3. Regression fixes — `src/middleware/webhookVerify.ts`

Reconstructed the corrupted middleware to the intended #1571 state:

- **Removed the dead duplicate verification body** (manual body reading, `nonceCache` replay check, its own catch block) and the conflicting `const nonceCache`/`const pendingNonces` `Set` declarations.
- **Restored the `record` telemetry helper** (emits `emitTelemetry` + a structured `logger.warn`) and the exported `WebhookVerifyOutcome` type (now including the new `invalid_body` outcome used by the payload-boundary rejection).
- **Wired `validateWebhookBody(req.body, getExpectedInboundNetwork())` into the telemetry flow** after JSON parsing: non-object payloads and wrong-network payloads are rejected `400`, and — critically — a rejected body does **not** consume the nonce, so a corrected retry with the same nonce/timestamp is accepted (pinned by `src/tests/webhookVerify.boundary.test.ts`).
- The full boundary is preserved: 413 payload-size bound via `readBody`, TOCTOU-safe nonce reservation, constant-time HMAC comparison, replay dedup with bounded memory, and 401 on missing/invalid headers, stale timestamps, tampered bodies, or replays.

### 4. Test-environment fixes (required for the suites to load at all)

- **`src/routes/milestones.idempotency.test.ts`** — fixed the corrupted template literal; added the missing `DuplicateVerifierVoteError` export and `getMilestonesByVaultId`/`allMilestonesMetThreshold` mocks; added `creator: 'user-1'` to the vault mock (the ownership check now reads it); added the wallet-identity headers (`x-wallet-address`, `x-network-id`) that `requireWalletIdentity` enforces on POST/PATCH milestone endpoints.
- **`src/tests/webhookVerify.boundary.test.ts`** — the `../config/index.js` mock was missing `config`, which `src/middleware/logger.ts` reads at module-init (`nodeEnv`, `logLevel`); added the subset so the suite loads.
- **`src/tests/adminVerifiers.test.ts`** — the mock of `../services/verifiers.js` was missing the exports the route imports (`deleteVerifierProfile`, `updateVerifierProfile`, `listVerifierProfiles`, `createOrGetVerifierProfile`); added them.
- **`src/tests/evidence.reindex.test.ts`** — `upsertEmbedding` test vectors were 2-element arrays against the repository's enforced 768-dimensional invariant; updated to `Array(768).fill(0.1)` while keeping the model-version pass-through assertions intact.

### 5. New focused tests — `src/routes/milestones.lifecycle.test.ts` (31 tests, new)

Route-level integration suite for the milestone lifecycle. It uses the **real** in-memory milestone service (seeding a milestone in the test populates the same table the router reads), so the full create → verify → vault-completion flow is exercised end-to-end; only the DB-backed surfaces (repo reads, vault transitions, verifier votes) are mocked.

| Endpoint | Success | Failure / boundary | Permission |
|---|---|---|---|
| `POST /` (create) | owner creates → 201, milestone fields + idempotency echo | invalid payload → 400; `approvalThreshold < 1` → 400; non-active vault → 409; unknown vault → 404 | non-owner → 403; unauthenticated → 401 |
| `GET /` (list) | returns rows (200) | unknown vault → 404 | — |
| — | **empty state**: vault with no milestones → `{ milestones: [] }` (200) | — | — |
| `PATCH /:id/verify` | verifies one of two → 200, `vaultCompleted: false` | unknown milestone → 404; malformed id → 400 | non-verifier → 403 |
| — | **boundary**: last milestone verified → `vaultCompleted: true`, `transitionVaultStatus(vaultId, 'completed')` called | — | — |
| `POST /:id/validate` | assigned verifier → 200, `verifiedBy`/`evidenceHash` set | missing evidence hash → 400; malformed hash → 400; unknown milestone → 404 | wrong verifier → 403 |
| — | **retry state**: replay after success → 409; **boundary**: last milestone → `vaultCompleted: true` | — | — |
| `POST /:id/approve` | records vote → 201 with `milestoneCompleted` + `vaultCompleted` | invalid `approvalStatus` → 400; unknown milestone → 404 | non-`approved` verifier profile → 403 |
| — | **retry safety**: duplicate vote → 409; concurrent race (`DuplicateVerifierVoteError`) → 409; already-settled → 409 | — | — |
| `GET /:id/approval-status` | 200 with threshold + progress | unknown milestone → 404; unknown vault → 404 | — |

### 6. New focused tests — `src/tests/milestoneLifecycle.test.ts` (+5 tests)

- Event ids embed a monotonic per-vault sequence (`m_<seq>_<suffix>`), distinct per event.
- The shared per-vault sequence stays monotonic across lifecycle transitions **and** manual `addMilestoneEvent` calls (1, 2, 3).
- `from`/`to` timestamp filters are **inclusive** on both bounds.
- Unparseable filter timestamps return an empty result instead of throwing.
- An idempotency-key replay of an already-applied transition is acknowledged as a duplicate even after the milestone is settled (the replay check precedes the settled guard — exactly-once semantics under retry).

### 7. Documentation — `docs/milestones.md`

- **Lifecycle regression contract**: monotonicity, atomic verified-field advancement, one ordered event per transition, inclusive filters, unparseable-filter safety, retry/idempotency semantics (including replay-after-settlement).
- **Adversarial-input invariants**: `recordMilestoneApproval` identifier/status validation; `getMilestoneApprovalProgress` threshold/totalVerifiers clamping.
- **Route-level authorization contract**: create requires wallet identity + vault ownership (creator/org/ADMIN); verify/validate/approve require VERIFIER/ADMIN + wallet identity; validate enforces the assigned verifier; approve rejects non-approved verifier profiles, duplicate votes, and settled milestones; malformed ids/payloads are rejected `400` at the boundary.
- **Accessibility note**: explicit statement that the feature is a server-side JSON API with no interactive UI in `disciplr-backend`, so keyboard/focus/screen-reader/responsive/reduced-motion checks are N/A; the API-level equivalent (stable `error.code`/`error.message` contract, consistent success shapes) is pinned by the route tests.

---

## Acceptance criteria mapping

| Acceptance criterion | Where it is satisfied |
|---|---|
| **The implementation defines and enforces the relevant invariants for normal and adversarial inputs** | Monotonic lifecycle state machine + ordered append-only ledger (`src/services/milestones.ts`); hostile-input guards in `recordMilestoneApproval` and `getMilestoneApprovalProgress` (`src/services/verifiers.ts`); route-level vault/state/permission guards (`src/routes/milestones.ts`); payload/network boundary in `webhookVerify.ts` |
| **Focused unit and integration tests for success, failure, loading, empty, retry, and permission states** | `src/routes/milestones.lifecycle.test.ts` (31 integration tests — success/failure/empty/retry/permission; "loading" maps to in-flight/concurrent duplicates, covered by the concurrent-race approve test and the concurrent-duplicate idempotency unit tests); `src/tests/milestoneLifecycle.test.ts` (29 unit tests) |
| **Verify keyboard, focus, screen-reader, responsive, and reduced-motion behavior where the feature is interactive** | **N/A — server-side JSON API; no interactive UI exists in this repository.** Documented in `docs/milestones.md` and this PR description. The API-level accessibility equivalent (stable machine-readable error contract) is pinned by tests |
| **Document the supported API/component contract and protect existing consumers from accidental breaking changes** | `docs/milestones.md` regression + authorization contract. Consumer-facing guarantees are additive and unchanged: existing exports keep signatures; `addMilestoneEvent` exactly-once dedup and `m_<seq>_<suffix>` event-id format were already documented; event/sequence semantics are now pinned by tests |
| **Automated tests cover success, failure, boundary, retry, and permission behavior applicable to this feature** | 212 milestone/verifier/webhook tests pass (see Validation); 36 new tests added by this PR |
| **The PR includes validation commands, design tradeoffs, and any remaining limitations** | This document + `docs/milestones.md` |
| **The PR references this issue** | `Closes #1525` at the top |

---

## Test matrix (new/affected suites)

| Suite | Type | Tests | Covers |
|---|---|---|---|
| `src/routes/milestones.lifecycle.test.ts` | integration (new) | 31 | success / failure / empty / retry / permission across all 6 endpoints |
| `src/tests/milestoneLifecycle.test.ts` | unit (+5) | 29 | lifecycle state machine, event ordering, idempotency, filter boundaries |
| `src/routes/milestones.idempotency.test.ts` | route (fixed) | 8 | replay, tampering, owner mismatch, malformed keys/responses, malformed ids |
| `tests/multiVerifier.veto.test.ts` | unit (unblocked) | 44 | veto math, hostile-input boundary for approvals/progress |
| `src/tests/milestone.lifecycle.test.ts` | repo (unblocked) | 7 | `verifyMilestoneAtomic`, `approveMilestoneAtomic`, `allMetThreshold` |
| `src/tests/evidence.reindex.test.ts` | repo (fixed) | 28 | milestone embedding repo + reindex job |
| `src/tests/adminVerifiers.test.ts` | route (fixed) | — | admin verifier lifecycle (mock now loadable) |
| `src/tests/webhookVerify.hardening.test.ts` | route (unblocked) | 17 | signature/replay/TOCTOU/413/telemetry contract |
| `src/tests/webhookVerify.boundary.test.ts` | route (fixed) | — | payload shape + network invariant, nonce-not-consumed retry |
| `tests/multiVerifier.test.ts`, `tests/adminVerifiers.lifecycle.test.ts` | route (unblocked) | — | multi-verifier + admin lifecycle |

**Total: 212/212 tests pass** across the milestone/verifier/webhook area.

---

## Security review

- **No secrets, credentials, or unsafe network defaults introduced.** All changes are internal correctness/contract fixes.
- **Authorization is checked, never inferred from client state**: the ownership check uses the verified principal (`req.user.userId`, `req.apiKeyAuth.orgId`) against server-side vault data (`creator`/`orgId`), not client-supplied fields.
- **Hostile input fails fast**: malformed verifier identifiers/statuses and degenerate thresholds are rejected/clamped before any DB write or progress verdict.
- **The webhook reconstruction keeps every security boundary**: constant-time HMAC comparison, TOCTOU-safe nonce reservation, bounded replay memory, 413 payload cap before parsing/HMAC, wrong-network rejection, and no secret/signature/body leakage in responses or telemetry.
- **Fail-closed behavior preserved**: malformed stored idempotency responses → 500 (no replay of garbage), per the existing idempotency contract.

---

## Validation

Run locally — all green:

```bash
npm run build                       # tsc — PASSES (was failing on 4 files before this PR)
npm run openapi:typecheck           # PASSES
npm run openapi:check               # docs/openapi.yaml up to date
npm test                            # 129 suites pass; the 11 failing suites fail identically on clean main (see Limitations)
```

Focused run (212/212):

```bash
node --experimental-vm-modules node_modules/jest/bin/jest.js --forceExit --testTimeout=30000 \
  src/routes/milestones.lifecycle.test.ts src/routes/milestones.idempotency.test.ts \
  src/tests/milestoneLifecycle.test.ts src/tests/milestone.lifecycle.test.ts \
  tests/multiVerifier.veto.test.ts tests/multiVerifier.test.ts tests/adminVerifiers.lifecycle.test.ts \
  src/tests/evidence.reindex.test.ts src/tests/adminVerifiers.test.ts \
  src/tests/webhookVerify.hardening.test.ts src/tests/webhookVerify.boundary.test.ts
# 212/212 pass
```

Lint: `npx eslint` was run on every changed file. The only errors are the repo-wide pre-existing classes (Jest globals undefined because the flat ESLint config defines no test globals; `no-explicit-any` in pre-existing route code). **None are introduced by this change**, and lint is not part of CI (`.github/workflows/ci.yml` runs build, OpenAPI checks, migrations, and `npm test`).

---

## Design tradeoffs

- **Ownership semantics now match the vaults route.** A vault's `creator`, an org-scoped principal matching `vault.orgId`, or an `ADMIN` may create milestones. The tradeoff: an admin who is neither the creator nor org-matched is still allowed (consistent with `vaults.ts` timeline/update authorization), which is a deliberate, pre-existing policy choice — not widened here.
- **Adversarial inputs fail in the service layer, not the route.** `recordMilestoneApproval` validates identifiers/status before opening the transaction, and progress math clamps thresholds. This keeps the guarantee for every caller (route, jobs, scripts), not just the HTTP boundary. The clamping behavior is the #1560 contract that #1565 reverted; the veto suite pins it.
- **Webhook reconstruction keeps the telemetry flow and folds in the payload boundary.** The `validateWebhookBody` shape/network check (the point of #1571's hardening) now runs inside the telemetry-enabled flow, and a malformed body never consumes the nonce. This is a strict superset of the previously-shipped behavior.
- **Route tests use the real in-memory milestone service** so create → verify → vault-completion runs end-to-end rather than being mocked into submission; only DB-backed surfaces are mocked. The tradeoff is that the in-memory service's own behaviors are what the route tests assert — which is exactly the contract the issue asks to pin, and the repository-level invariants are covered separately by `src/tests/milestone.lifecycle.test.ts` (mocked knex).
- **Event-id format is unchanged and documented as additive.** The `m_<seq>_<suffix>` format was already introduced in #1570; this PR only pins it with tests. Consumers keying on the exact id format already had to match `m_<seq>_<suffix>`.

---

## Remaining limitations / pre-existing CI failures

All of the following fail **identically on clean `main`** (verified by stashing this PR's changes and re-running); none are touched here, per the issue's non-goals:

- `src/tests/migrations.rollback.test.ts` — requires the Postgres service; **passes in CI**, which provisions one (`postgres:16` service in `ci.yml`).
- `src/observability/httpMetrics.test.ts`, `src/middleware/privacy-logger.test.ts`, `src/tests/orgAuth.test.ts`, `src/tests/orgAuth.dbErrors.test.ts` — "jest is not defined": these suites use the `jest` global without importing from `@jest/globals`, which does not resolve under this repo's ts-jest ESM setup.
- `src/tests/verifications.bulk.test.ts`, `src/tests/verifications.idempotency.test.ts` — stale expectations around `EvidenceReferenceValidationError`/evidence-reference error mapping in the bulk check-in endpoint.
- `src/tests/webhooks.eventFilters.test.ts`, `src/tests/vault.retentionPurge.test.ts`, `src/tests/membership.permissions.test.ts`, `src/tests/auditLogs.integrity.test.ts` — unrelated feature suites with pre-existing mock/pool or assertion drift.
- `src/tests/fixtures.test.ts`, `src/tests/retry.test.ts` — flake intermittently under full parallel load but pass in isolation and in every targeted run.

These are outside the milestone-lifecycle scope; fixing them would touch unrelated features. **No tests were removed to make CI pass.**

## Follow-up stability

- The new route suite seeds from the real service and resets all state in `beforeEach`, so it is order-independent and safe to parallelize.
- The verifier mock exports mirror the real module's surface, so when `src/services/verifiers.ts` gains or loses exports, the route suites will fail loudly at load time rather than silently stub.
- The webhook reconstruction is validated by both the hardening suite (telemetry, 413, TOCTOU) and the boundary suite (payload/network invariants, nonce-not-consumed retry), so a future refactor of the verification flow is regression-guarded from two angles.

## Non-goals respected

No typo-only, doc-only, formatting-only, or dependency-only changes; no tests removed; no secrets introduced; no unrelated refactors. Every source change is required to restore the milestone/webhook/verifier features to a compiling, CI-passing state or to satisfy an acceptance criterion of #1525.
