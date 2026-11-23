# Field Encryption at Rest

Some secrets stored by Disciplr cannot be hashed because they must be recovered
in plaintext at use time. The clearest example is a **webhook HMAC signing
secret**: to sign every outbound delivery the server must present the original
secret, so a one-way hash (as used for API keys) is not an option. Those columns
are instead **encrypted at rest** with authenticated encryption.

This document describes the scheme and the key-rotation runbook.

## What is encrypted

| Column                                  | Reversible? | Storage          |
| --------------------------------------- | ----------- | ---------------- |
| `webhook_subscribers.secret`            | yes         | AES-256-GCM      |
| `webhook_subscribers.previous_secret`   | yes         | AES-256-GCM      |
| `api_keys.key_hash`                     | no          | Argon2id + SHA-256 (unchanged) |

API keys remain hashed (irreversible) — they are verified, never re-presented,
so they do **not** use this mechanism.

## Scheme

Encryption is implemented in [`src/lib/encryption.ts`](../src/lib/encryption.ts)
using **AES-256-GCM** (authenticated encryption). Each value is stored as a
single self-describing string:

```
v1:<kid>:<iv_b64>:<authTag_b64>:<ciphertext_b64>
```

- `v1` — scheme version, so the format can evolve.
- `<kid>` — id of the key that produced this ciphertext. Resolved back to key
  material on decryption, which is what makes rotation possible without bulk
  re-encryption.
- `<iv_b64>` — 12-byte random nonce (a fresh IV per encryption).
- `<authTag_b64>` — 16-byte GCM authentication tag.
- `<ciphertext_b64>` — the ciphertext.

Properties:

- **Confidentiality** — a database dump alone never exposes the plaintext.
- **Integrity / tamper detection** — any modification to the stored value fails
  the GCM authentication check on decrypt.
- **Fail closed** — decryption throws `DecryptionError` on a wrong key, an
  unknown key id, malformed input, or a failed auth check. It **never** returns
  the ciphertext or a partial result, so corrupt or forged data can never be
  silently mistaken for plaintext.

## Key configuration

Keys are supplied via environment variables (see
[`src/config/env.ts`](../src/config/env.ts)). Two forms, in priority order:

1. **`FIELD_ENCRYPTION_KEYS`** — a JSON array of `{ kid, key }` objects, where
   `key` is a base64-encoded **32-byte** (AES-256) key. The **first** entry is
   the active key used to encrypt new data; the remaining entries are retained
   only so ciphertext written under an older `kid` still decrypts.

   ```
   FIELD_ENCRYPTION_KEYS=[{"kid":"2026-06","key":"<base64-32-bytes>"},{"kid":"2026-01","key":"<old-base64-32-bytes>"}]
   ```

2. **`FIELD_ENCRYPTION_KEY`** — a single base64-encoded 32-byte key, treated as
   the active key under the reserved key id `default`. Convenient for
   development and single-key deployments. Ignored when `FIELD_ENCRYPTION_KEYS`
   is set.

Generate a key:

```sh
openssl rand -base64 32
```

If neither variable is set, the encryption helpers throw `EncryptionKeyError` —
an encryption layer with no key is treated as a misconfiguration (fail closed),
never as a silent no-op.

## Key-rotation runbook

Rotation is **zero-downtime** and requires no bulk re-encryption, because every
ciphertext carries the `kid` of the key that produced it.

1. **Generate a new key.**

   ```sh
   openssl rand -base64 32
   ```

2. **Prepend it to `FIELD_ENCRYPTION_KEYS`, keeping the old key.** The new key
   becomes active (it is first); the old key is retained so existing rows keep
   decrypting. Choose a `kid` that is stable and meaningful (e.g. a date).

   ```
   FIELD_ENCRYPTION_KEYS=[
     {"kid":"2026-09","key":"<new-base64-32-bytes>"},
     {"kid":"2026-06","key":"<previous-base64-32-bytes>"}
   ]
   ```

   > If you were previously using the single-key `FIELD_ENCRYPTION_KEY`, migrate
   > to `FIELD_ENCRYPTION_KEYS` and include the old key under the `kid`
   > `"default"`, since that is the id under which it encrypted existing rows.

3. **Deploy.** From this point, all newly written secrets are encrypted under
   the new `kid`; old rows continue to decrypt under the retained key.

4. **(Optional) Re-encrypt existing rows.** Any write path that re-saves a
   secret (creating, upserting, or rotating a webhook subscriber's secret)
   automatically re-encrypts it under the active key. To migrate all rows
   eagerly, read and re-save each affected row.

5. **Retire the old key.** Once you are confident no ciphertext is still tagged
   with the old `kid` (after step 4, or after enough time that all such rows
   have been rewritten), remove that entry from `FIELD_ENCRYPTION_KEYS` and
   deploy again.

   > **Do not remove a key while rows tagged with its `kid` still exist** —
   > those rows would become permanently undecryptable and reads would throw
   > `DecryptionError`.

## Operational notes

- **Never log key material.** Keys are provided only through environment
  variables / your secrets manager and are never written to logs.
- **Back up keys** in your secrets manager. Losing a key whose `kid` still tags
  live rows means losing those secrets irrecoverably.
- **Decryption failures are loud.** A `DecryptionError` on read indicates either
  a removed/rotated-out key (`No field encryption key configured for key id …`)
  or tampered data (`authentication failed`). Investigate rather than suppress.
