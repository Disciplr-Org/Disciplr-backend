# Feature Flags

Feature flags support per-organization overrides, attribute targeting, and deterministic percentage rollout.

Evaluation precedence:

1. Organization-specific rows are explicit allow/deny overrides.
2. Global `rules` are evaluated in stored order and override percentage rollout.
3. Global `rollout_percentage` uses a stable SHA-256 bucket of `(flagKey, orgId)`.
4. Global `enabled` is the fallback default.

Rules are JSON arrays. Supported operators are `eq`, `neq`, `in`, and `not_in`; omitted `operator` defaults to `eq`, and omitted `enabled` defaults to `true`.

Example:

```json
[
  { "attribute": "plan", "operator": "eq", "value": "enterprise", "enabled": true },
  { "attribute": "region", "operator": "eq", "value": "restricted", "enabled": false }
]
```

Pass request-time organization attributes to `getFlag(name, orgId, context)`, for example `{ "plan": "enterprise" }`.
