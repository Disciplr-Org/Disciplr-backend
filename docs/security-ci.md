# Security in CI/CD

This document describes the security scanning and policies enforced in the Disciplr continuous integration pipeline.

## Secret Scanning (gitleaks)

A dedicated `secret-scan` job runs in parallel with tests on every push and pull request to `main`.

- **Tool:** [gitleaks](https://github.com/gitleaks/gitleaks) via `gitleaks/gitleaks-action@v2`
- **Config:** `.gitleaks.toml` (extends the default rule set)
- **Policy:** The job **fails** when a non-allowlisted secret is detected in the repository history for the checked-out ref.
- **Triggers:** `push` and `pull_request` to `main`

### Allowlist

Some paths contain intentional placeholder or example credentials used in tests and documentation. These are excluded via path allowlist in `.gitleaks.toml`:

| Path / pattern | Reason |
|----------------|--------|
| `.env.example` | Documented placeholder environment values |
| `docs/audit-logs.md` | Redaction example with fake `sk_live_` API key |
| `docs/audit-logs-validation.md` | Sanitization test-case example |
| `docs/idempotency.md` | Example idempotency-key values in API samples |
| `docs/horizon-events.md` | Example Horizon paging tokens in API samples |
| `src/tests/**` | Test fixtures (JWTs, Stellar keys, mock credentials) |
| `tests/**` | Integration test fixtures |
| `**/*.test.ts` | Unit test fixtures (e.g. `apiKeyAuth.test.ts`) |

To add a new allowlisted fixture:

1. Confirm the value is not a real credential.
2. Add the file path to `[allowlist].paths` in `.gitleaks.toml`.
3. Document the entry in the table above.

### Local validation

Install gitleaks (macOS: `brew install gitleaks`) and run from the repo root:

```bash
gitleaks detect --source . --config .gitleaks.toml --verbose
```

Expected: exit code `0` on a clean tree.

To confirm the gate catches real leaks, create a scratch branch and add a dummy secret outside allowlisted paths (do not merge). Use a clearly fake value — do **not** use realistic provider key formats (e.g. Stripe `sk_live_…`), or GitHub push protection may block the push:

```bash
git checkout -b scratch/gitleaks-smoke
printf '%s\n' 'const LEAKED = "DUMMY_GITLEAKS_SMOKE_TEST_ONLY_NOT_A_REAL_SECRET"' > src/leak-smoke.ts
gitleaks detect --source . --config .gitleaks.toml --no-git
rm -f src/leak-smoke.ts
```

Expected: non-zero exit if gitleaks matches the planted value (provider-shaped keys are more reliably detected).

## Software Bill of Materials (SBOM)

The `sbom` job generates a CycloneDX SBOM from the Bun lockfile and uploads it as a CI artifact.

- **Tool:** `@cyclonedx/cdxgen`
- **Input:** `bun.lock` (after `bun install --frozen-lockfile`)
- **Output:** `sbom.json` (CycloneDX 1.5)
- **Artifact name:** `sbom-cyclonedx` (retained 90 days)

### Local validation

```bash
bun install --frozen-lockfile
bunx @cyclonedx/cdxgen -o sbom.json --spec-version 1.5
test -s sbom.json && jq -e '.bomFormat == "CycloneDX"' sbom.json
```

## Dependency Advisory Gate

The `dependency-audit` job scans `bun.lock` against the npm advisory database and **fails** on advisories at or above the configured severity.

- **Tool:** `bun audit`
- **Severity gate:** `high` (blocks high and critical advisories)
- **Configuration:** `DEPENDENCY_AUDIT_LEVEL` in `.github/workflows/ci.yml`

Allowed values: `low`, `moderate`, `high`, `critical`. Raising the gate to `critical` would only block critical advisories; lowering to `moderate` would also block moderate issues.

### Local validation

```bash
bun audit --audit-level=high
```

To ignore a specific advisory temporarily (requires justification in the PR):

```bash
bun audit --audit-level=high --ignore CVE-YYYY-NNNNN
```

## Dependency Vulnerability Scanning (GitHub)

### GitHub Dependency Review

We use the `actions/dependency-review-action` to scan dependencies in pull requests for known vulnerabilities.

- **Trigger:** Runs on every pull request to `main` (see `.github/workflows/codeql.yml`).
- **Fail on Severity:** High (blocks PRs with high or critical vulnerabilities in runtime dependencies).
- **Scopes Checked:** Only runtime dependencies (devDependencies are excluded).

## Static Code Analysis

### CodeQL

We use GitHub CodeQL to perform static code analysis on the TypeScript codebase.

- **Triggers:**
  - Runs on every pull request to `main`.
  - Runs on every push to `main`.
  - Scheduled weekly scan on `main` (Sunday at midnight UTC).
- **Languages Analyzed:** TypeScript.
- **Capabilities:** Detects injection vulnerabilities, unsafe data flows, and other common security issues.

## Lockfile Policy

To ensure consistent builds and prevent malicious dependency injection during the build process, we enforce a strict lockfile policy.

1. **Existence Check:** `bun.lock` must exist in the repository.
2. **Consistency Check:** `bun install --frozen-lockfile` is used in CI to verify the lockfile matches `package.json`.

## Secure Configuration

- **Least Privilege:** CI jobs run with the minimum necessary permissions.
- **Secrets Management:** Sensitive tokens or keys are never logged in CI output.
- **Actionable Output:** Security reports are generated in JSON format for potential integration with external monitoring tools.

## Encryption at Rest

Reversible secrets that cannot be hashed (e.g. webhook HMAC signing secrets) are
encrypted at rest with AES-256-GCM and a rotatable, key-id-tagged key. See
[field-encryption.md](./field-encryption.md) for the scheme and the key-rotation
runbook.

## Best Practices for Developers

- Run `gitleaks detect` locally before pushing if you add fixtures that resemble secrets.
- Run `bun audit --audit-level=high` locally before committing dependency changes.
- Address vulnerabilities by updating affected packages where possible.
- Ensure `bun.lock` is always committed along with `package.json` changes.
- Review CodeQL findings in PRs before merging.
