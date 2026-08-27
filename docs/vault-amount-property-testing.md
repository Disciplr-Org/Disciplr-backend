# Vault amount and milestone property testing

Issue #1509 adds a bounded, deterministic property suite around the shared
`createVaultSchema` and `parseMilestoneInput` validation boundary. The suite is
in `src/services/vaultValidation.property.test.ts` and uses the repository's
already-pinned `fast-check` dependency.

## Algebraic invariants

For a vault amount `V` and milestone amounts `m1...mn`, valid generated cases
must satisfy:

```text
V >= 1
1 <= n <= 20
mi >= 1 for every i
sum(mi) <= V
```

The constrained schedule generator reserves one minimum unit for each future
milestone before selecting the current amount. The resulting schedule always
uses the entire vault amount in its primary property, which exercises the
inclusive allocation boundary. A second set of properties deliberately adds
one unit and proves that the schema rejects the first invalid value.

The property suite also checks that reversing or sorting a valid schedule does
not change acceptance. The schema validates the allocation total, not a
particular milestone order.

The decimal grammar is deliberately strict: amounts contain decimal digits and
at most seven fractional digits. Exponent notation, hexadecimal notation,
separators, and additional precision are rejected instead of being silently
reinterpreted by JavaScript's `Number` parser. This keeps the accepted value
space aligned with the settlement precision documented below.

## Precision policy

The API accepts decimal amounts as strings and the existing schema constrains
them by finite numeric value. The property suite generates seven decimal
places—the supported Soroban-style precision used by this service—and keeps an
exact `bigint` representation in the generator. The exact representation is
used to prove that generated allocations sum to the vault before values are
converted to strings for schema validation.

Validation is intentionally deterministic: repeated parsing of the same
input produces the same issue messages. The suite does not use floating-point
randomness to decide whether a case is valid.

## Adversarial inputs

The suite covers the following classes of failures:

- negative, zero, signed-zero, empty, whitespace, and non-finite values;
- numeric overflow and values above the practical maximum;
- malformed numeric strings such as hexadecimal, separators, `Infinity`, and
  `NaN`;
- malformed milestone objects and missing required fields;
- empty titles and invalid UTC timestamps;
- schedules before the vault start date;
- an end date equal to the start date;
- too few and too many milestones; and
- invalid verifier, creator, contract, and destination address shapes.

Every adversarial case is asserted to return a safe validation failure rather
than throw unexpectedly. Positive and negative boundary properties exercise
both the root vault amount and standalone milestone amount schema.

## Reproducibility and shrinking

Every property uses seed `1509`, a maximum of 100 runs, and
`endOnFailure: true`. Individual properties offset the seed by a small,
documented amount so a failing property can be replayed without making the
entire suite depend on execution order. `fast-check` shrinks generated arrays,
weights, and amounts toward the smallest failing schedule. Custom assertion
messages include the minimized schedule and Zod issue messages.

To replay a failure locally, keep the property seed from the test output and
temporarily pass it as the `seed` option to the affected `fc.assert` call. The
run count is intentionally bounded for CI stability; the generators still
exercise multiple schedule lengths and precision boundaries on each property.

## Why the tests target the schema

The schema is the shared boundary used before persistence and before optional
on-chain submission. Testing it directly catches regressions that would be
missed by testing only the in-memory transition helpers. The tests do not
mutate production data, require a database, call Horizon, or use secrets.

The suite does not claim to prove arbitrary-precision arithmetic inside every
downstream consumer. It verifies the current accepted precision and the exact
integer allocation invariant at the validation boundary. If the service later
raises the amount maximum or changes precision, the generator constants and
these documented properties must be updated together.
