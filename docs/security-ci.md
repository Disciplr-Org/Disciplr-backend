# Security in CI/CD

This document describes the security scanning and policies enforced in the Disciplr continuous integration pipeline.

## Dependency Vulnerability Scanning

### GitHub Dependency Review

We use the `actions/dependency-review-action` to scan dependencies in pull requests for known vulnerabilities.
- **Trigger:** Runs on every pull request to `main`.
- **Fail on Severity:** High (blocks PRs with high or critical vulnerabilities in runtime dependencies).
- **Scopes Checked:** Only runtime dependencies (devDependencies are excluded).

### `npm audit`

We use `npm audit` to scan dependencies for known vulnerabilities.
- **Audit Level:** High (scans for high and critical vulnerabilities).
- **Policy:** Currently configured as `continue-on-error: true` (report-only) to allow for manual review without blocking development. In the future, this may be set to block PRs with critical vulnerabilities.

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

1. **Existence Check:** `package-lock.json` must exist in the repository.
2. **Consistency Check:** `npm ci --dry-run` is used to verify that the `package-lock.json` is consistent with `package.json`. If they are out of sync, the CI job will fail.

## Secure Configuration

- **Least Privilege:** CI jobs run with the minimum necessary permissions.
- **Secrets Management:** Sensitive tokens or keys are never logged in CI output.
- **Actionable Output:** Security reports are generated in JSON format for potential integration with external monitoring tools.

## Best Practices for Developers

- Always run `npm audit` locally before committing dependency changes.
- Address vulnerabilities by running `npm audit fix` where possible.
- Ensure `package-lock.json` is always committed along with `package.json` changes.
- Review CodeQL findings in PRs before merging.
