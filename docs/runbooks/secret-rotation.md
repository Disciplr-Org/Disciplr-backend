# Runbook: Secret Rotation

**Severity:** P1 for suspected compromise; P2 for scheduled rotation
**Owner:** On-call engineer, with the security owner for suspected compromise
**Related docs:** [Operations Guide](../operations.md) · [Field Encryption at Rest](../field-encryption.md) · [Disaster Recovery](disaster-recovery.md)

---

## Symptoms

- Authentication begins returning `401` after a deployment or secret update.
- Webhook consumers report signature failures or deliveries start failing.
- Logs contain `DecryptionError`, an unknown field-encryption `kid`, or webhook secret decryption failures.
- A secret is suspected to have been exposed and must be replaced immediately.

Do not paste secret values, bearer tokens, webhook payload signatures, or complete
environment dumps into tickets, chat, shell history, or logs. For a suspected
compromise, use the emergency steps below rather than waiting for the normal
overlap windows.

## 1. Diagnosis

### 1.1 Confirm application and deployment state

Check the deployment's normal health and logs; do not print secret values:

```bash
curl -fsS https://<API_HOST>/api/health

# Check whether the expected variables are present without displaying values.
for name in JWT_KEYS JWT_SECRET JWT_ACCESS_SECRET JWT_REFRESH_SECRET \
  FIELD_ENCRYPTION_KEYS FIELD_ENCRYPTION_KEY WEBHOOK_INBOUND_SECRET; do
  if printenv "$name" >/dev/null; then printf '%s: set\n' "$name"; else printf '%s: unset\n' "$name"; fi
done
```

Inspect the deployment's secret-manager revision and application logs for
`EncryptionKeyError`, `DecryptionError`, and `webhook.inbound_verify` outcomes.
The inbound verifier emits outcomes such as `bad_signature` and `no_secret`;
never enable logging of the secret or signature to diagnose these errors.

### 1.2 Check webhook subscriber key usage

`webhook_subscribers.secret` and `previous_secret` contain encrypted values
(`v1:<kid>:...`) or may contain legacy plaintext values. Count records without
selecting their contents:

```sql
SELECT key_id, column_name, COUNT(*) AS row_count
FROM (
  SELECT CASE WHEN secret LIKE 'v1:%'
              THEN split_part(secret, ':', 2)
              ELSE 'legacy-or-unrecognized' END AS key_id,
         'secret' AS column_name
  FROM webhook_subscribers
  UNION ALL
  SELECT CASE WHEN previous_secret LIKE 'v1:%'
              THEN split_part(previous_secret, ':', 2)
              ELSE 'legacy-or-unrecognized' END AS key_id,
         'previous_secret' AS column_name
  FROM webhook_subscribers
  WHERE previous_secret IS NOT NULL
) AS stored_keys
GROUP BY key_id, column_name
ORDER BY key_id, column_name;
```

The `previous_secret` and `rotated_at` columns are added by migration
`20260627130000_add_webhook_secret_rotation.cjs`. If the query reports those
columns missing, confirm the migration status before rotating subscriber
secrets.

### 1.3 Check recent webhook rotations

```sql
SELECT id, organization_id, active, rotated_at, updated_at
FROM webhook_subscribers
WHERE active = true
ORDER BY rotated_at DESC NULLS LAST
LIMIT 25;
```

Do not query or print `secret` or `previous_secret` values.

### 1.4 Confirm the deployed rotation interfaces

The user-facing subscriber rotation route is
`POST /api/webhooks/:id/rotate-secret?orgId=<ORG_ID>` (authenticated and
organization-authorized). The admin route is
`POST /api/admin/webhooks/subscribers/:id/rotate-secret` (authenticated
administrator; body requires `organization_id` and `new_secret`). The admin
subscriber list is
`GET /api/admin/webhooks/subscribers?organization_id=<ORG_ID>`.

The inbound webhook verifier uses the single `WEBHOOK_INBOUND_SECRET`
environment variable. It does not have a previous-secret grace period.

## 2. Remediation

### 2.1 Rotate keyed application JWTs (`JWT_KEYS`)

`JWT_KEYS` is a JSON array of `{ "kid", "secret", "retiredAt"? }`. The first
key without `retiredAt` signs new access and refresh tokens. Verification
accepts tokens by `kid` while the matching key is configured and has not passed
its `retiredAt`. Keep the old key through the longest lifetime of tokens it
signed (normally refresh-token lifetime, `JWT_REFRESH_EXPIRES_IN`, default
`7d`), plus clock skew.

1. Generate a new high-entropy secret in the approved secrets manager. Assign a
   new, unique `kid`.
2. Deploy the new key first, retaining the old key with a future retirement
   timestamp beyond the token lifetime. Example shape only:

   ```text
   JWT_KEYS=[{"kid":"<NEW_KID>","secret":"<NEW_SECRET>"},{"kid":"<OLD_KID>","secret":"<OLD_SECRET>","retiredAt":"<UTC_RETIREMENT_AFTER_TOKEN_EXPIRY>"}]
   ```

3. Roll out all instances and verify sign-in/refresh with the normal, authorized
   authentication smoke test. New tokens should use `<NEW_KID>`; old keyed
   tokens should continue working during the overlap.
4. After the retirement timestamp and after confirming no live tokens need the
   old key, remove the old entry and deploy again.

Keep the legacy `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, and `JWT_SECRET`
unchanged while legacy tokens without a `kid` may still exist; the verifier
uses those single-secret fallbacks for such tokens. Do not remove a `JWT_KEYS`
entry early: existing tokens using that `kid` will no longer verify.

### 2.2 Rotate OAuth tokens signed with `JWT_SECRET`

OAuth tokens from `POST /api/oauth/token` are signed directly with `JWT_SECRET`;
`authenticateOAuthBearer` verifies them using that one configured secret.
There is no `JWT_KEYS` overlap for these tokens. A `JWT_SECRET` change
immediately invalidates outstanding OAuth bearer tokens and legacy application
tokens that use this fallback. For a scheduled rotation, coordinate with OAuth
clients, stop or pause their use, wait for the maximum issued OAuth token
lifetime (`OAUTH_TOKEN_TTL_SECONDS`, capped at 12 hours in the route) and any
legacy application-token lifetime, update `JWT_SECRET`, deploy, and have
clients request new tokens.
If the secret is compromised, rotate immediately and expect clients to
re-authenticate; do not claim a no-downtime overlap that the verifier does not
support.

### 2.3 Rotate field-encryption keys

Field-encryption keys are base64-encoded 32-byte AES keys. The first entry in
`FIELD_ENCRYPTION_KEYS` encrypts new values; later entries allow old values to
decrypt. `FIELD_ENCRYPTION_KEYS` takes precedence over the single-key
`FIELD_ENCRYPTION_KEY`.

1. Generate a key with `openssl rand -base64 32` and store it directly in the
   secrets manager.
2. Put the new key first, retaining every existing key. When migrating from
   `FIELD_ENCRYPTION_KEY`, include its value in the array with `kid` `"default"`
   so existing ciphertext remains readable:

   ```text
   FIELD_ENCRYPTION_KEYS=[{"kid":"<NEW_KID>","key":"<NEW_BASE64_32_BYTE_KEY>"},{"kid":"<OLD_KID>","key":"<OLD_BASE64_32_BYTE_KEY>"}]
   ```

3. Roll out the new configuration. New/updated webhook subscriber values are
   encrypted with the new key; existing ciphertext remains decryptable using
   its `kid`. No bulk re-encryption is required for continuity.
4. If you choose to re-encrypt old current secrets, re-save them through a
   supported application write path, then re-run §1.2. Subscriber rotation
   copies the existing ciphertext verbatim into `previous_secret`; it does not
   re-encrypt that column. Do not remove an old key until its count is zero in
   both columns for all records, including inactive subscribers. Retain the old
   key if any `previous_secret` still depends on it; never rewrite ciphertext
   directly in SQL.
5. Remove the retired key and deploy only after that check. If `FIELD_ENCRYPTION_KEYS`
   is used, do not leave a stale `FIELD_ENCRYPTION_KEY` value that could confuse
   operators; the array is the active source of truth.

### 2.4 Rotate outbound webhook subscriber secrets

The user-facing rotation endpoint generates a new secret and returns it in
the response once. The server stores the old encrypted value in
`previous_secret`; new deliveries are signed with the new secret immediately.
`WEBHOOK_SECRET_GRACE_WINDOW_MS` (default 24 hours) marks the overlap window
for the previous secret. The webhook consumer must already know the old secret
and implement any dual-secret verification it needs; the application does not
return the old secret during rotation.

1. Notify the webhook consumer and arrange to store the returned new secret in
   its approved secret manager. Use the consumer's tested dual-secret
   verification during the grace period where available.
2. Rotate one subscriber at a time:

   ```bash
   curl -fsS -X POST \
     "https://<API_HOST>/api/webhooks/<SUBSCRIBER_UUID>/rotate-secret?orgId=<ORG_ID>" \
     -H "Authorization: Bearer <USER_ACCESS_TOKEN>" \
     -H "Content-Type: application/json"
   ```

   Securely capture the `secret` in the response; it is not recoverable from
   the API later. Do not save the response in terminal transcripts, CI logs, or
   tickets. This endpoint requires no request body.
3. Deliver a test webhook and confirm the consumer verifies it with the new
   secret. Keep the prior secret available to the consumer until the grace
   window expires.
4. Check `rotated_at` and delivery metrics/logs. The old ciphertext is retained
   in `previous_secret`; do not clear or modify encrypted columns with manual
   SQL.

Administrators can instead call
`POST /api/admin/webhooks/subscribers/<SUBSCRIBER_UUID>/rotate-secret` with
`{"organization_id":"<ORG_ID>","new_secret":"<NEW_SECRET>"}`. That endpoint
does not return the new secret; securely deliver the supplied secret to the
consumer before rotating.

### 2.5 Rotate inbound webhook verifier secret

`WEBHOOK_INBOUND_SECRET` is a single secret and the verifier has no built-in
dual-secret period. Coordinate a sender-side change and update the application
environment as a synchronized cutover. The sender must begin signing with the
new value as instances use it. If the sender cannot coordinate the cutover,
expect failed requests until both sides are aligned. On suspected compromise,
replace it immediately and notify the sender to use the replacement.

## 3. Rollback

- **JWT_KEYS:** Restore the prior configuration with both old and new keys
  present, keeping the intended active key first. Do not restore a configuration
  that omits a key still signing unexpired tokens.
- **JWT_SECRET:** Restore the prior value only if it is not compromised and
  clients still require tokens signed with it. Otherwise leave the new value in
  place and make clients re-authenticate.
- **Field encryption:** Restore a configuration that includes every key needed
  to decrypt stored `kid`s. Never roll back by removing the active or retained
  keys from the only running configuration. Confirm decryption health before
  proceeding.
- **Outbound webhook:** If the consumer has not accepted the new value, rotate
  again through the supported endpoint to make another fresh secret active and
  coordinate a new consumer update. Do not manually swap ciphertext columns;
  the endpoint preserves only the immediately prior value for the grace period.
- **Inbound webhook:** Restore the previous value only if it is still trusted
  and coordinate the sender to match. If compromised, do not roll it back.

If rollback does not restore successful authentication/decryption, stop further
key removal or rotations and escalate.

## 4. Escalation

Escalate immediately to the security owner and incident commander when a secret
may be compromised, a retired encryption key is missing, or decryption errors
affect stored data. Contact the owning application/service team if the failure
is limited to one JWT consumer or webhook subscriber. Preserve deployment
revision identifiers, timestamps, affected `kid` values, subscriber IDs, and
error categories; never preserve secret values or token contents in the
incident record.

## 5. Post-incident checklist

- [ ] Confirm all application instances use the intended secret-manager
      revision and are healthy.
- [ ] Verify authentication/refresh for keyed JWTs; verify OAuth clients can
      obtain a new token after a `JWT_SECRET` change.
- [ ] Confirm all active webhook consumers verify deliveries with their new
      secrets and the configured grace period has elapsed before discarding
      prior values.
- [ ] Re-run the key-usage SQL and verify every removed field-encryption `kid`
      has zero remaining rows, including inactive subscribers.
- [ ] Confirm no `DecryptionError`, unknown-`kid`, unexpected `401`, or webhook
      signature-failure signals remain.
- [ ] Record rotated secret identifiers/revisions and the retirement time;
      never record secret material.
- [ ] Update the secret inventory and schedule follow-up removal of any
      retained keys that are no longer needed.

## 6. Verified endpoints and tables

| Resource | Purpose |
|---|---|
| `GET /api/health` | Basic application health |
| `POST /api/oauth/token` | Issues OAuth bearer tokens signed with `JWT_SECRET` |
| `POST /api/webhooks/:id/rotate-secret` | Generates a replacement subscriber secret |
| `GET /api/admin/webhooks/subscribers?organization_id=<ORG_ID>` | Lists subscriber metadata, including `rotated_at` |
| `POST /api/admin/webhooks/subscribers/:id/rotate-secret` | Admin-supplied subscriber secret rotation |
| `webhook_subscribers` | Subscriber ciphertext in `secret` and `previous_secret`; rotation time in `rotated_at` |
