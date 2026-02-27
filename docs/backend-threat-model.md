# Backend Threat Model Assumptions

This document describes the security assumptions for the backend API and how issue #43 controls map to threats.

## Assets

- Validation decisions (approval/rejection records)
- Evidence payloads submitted during validation
- API credentials (JWTs, API keys, encryption key material)

## Trust Boundaries

- External clients to API server (untrusted network input)
- API server to data-at-rest layer (in-memory today, database/object store in production)
- Identity provider / token issuer to API server

## Assumptions

- JWT signing key (`JWT_SECRET`) is managed securely and rotated out-of-band.
- Evidence encryption key (`EVIDENCE_ENCRYPTION_KEY`) is provided securely by runtime secret management in production.
- TLS is enforced in deployment for all client and service traffic.
- Verifier role assignment is governed by upstream identity and authorization policy.
- Off-chain persistence layer provides durability and access controls, but application-level encryption is still required.

## Controls Implemented

- Verification endpoints are protected by `authenticate` + `requireVerifier` middleware.
- Validation transaction creation requires `Idempotency-Key` and enforces request replay semantics:
  - Same key + same payload returns existing transaction.
  - Same key + different payload is rejected with conflict.
- Evidence is encrypted before storage with AES-256-GCM; API responses expose metadata only.

## Out of Scope / Future Hardening

- Key rotation and re-encryption workflows for historical evidence.
- Multi-region replay protection for idempotency keys when horizontally scaling.
- Tamper-evident audit logs shipped to immutable storage.
- DLP and malware scanning for uploaded evidence payloads.
