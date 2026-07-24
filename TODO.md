# TODO

## Plan confirmation (pre-edit)
- Implement admin suspend + reinstate endpoints (POST /api/admin/verifiers/:userId/suspend and .../reinstate)
- Wire suspend/reinstate to verifier status transitions (suspended <-> pending/approved as "prior active")
- Ensure suspended verifiers are rejected by validateMilestoneMultiVerifier() during multi-verifier milestone approvals
- Add audit logging for both lifecycle transitions and blocked approval attempts
- Add tests covering:
  - suspend sets deactivated/suspended status correctly and writes audit log
  - reinstate restores prior state
  - suspended verifier cannot approve milestones; historical votes remain

## Steps
1. Inspect current milestone multi-approval flow and where validateMilestoneMultiVerifier is used.
2. Update services/milestones.ts to block suspended/deactivated verifiers (query verifier status).
3. Update adminVerifiers routes to add reinstate path and correct lifecycle transitions (and audit).
4. Implement service helpers in services/verifiers.ts for reinstate "prior active state".
5. Add/modify tests in tests/ for lifecycle + multi-verifier approval blocking.
6. Run test suite.

