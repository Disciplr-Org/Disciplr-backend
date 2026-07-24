# Milestone + Admin Verifier lifecycle wiring

## Goal
- Add admin endpoint `POST /api/admin/verifiers/:userId/reinstate`.
- Ensure suspend/reinstate transitions correctly set verifier status and are audited.
- Block suspended/deactivated verifiers from casting milestone approvals while keeping historical votes intact.
- Add tests and documentation.

## Implementation checklist
1. **Admin routes** (`src/routes/adminVerifiers.ts`)
   - Add `POST /api/admin/verifiers/:userId/reinstate`.
   - Implement reinstate semantics:
     - If prior status was `approved`, restore to `approved`.
     - Else restore to `pending`.
   - Keep `POST /:userId/suspend` but ensure it is consistent with “set deactivated verifier status”.

2. **Verifier service helpers** (`src/services/verifiers.ts`)
   - Add function to reinstate based on timestamps:
     - If verifier has `approved_at` present historically => restore to `approved`.
     - Otherwise => restore to `pending`.
   - Add audit log actions:
     - `verifier.reinstated` (or `verifier.reactivated` already exists but ensure correct action string)
     - Add explicit audit metadata for lifecycle reason.

3. **Block votes** (`src/services/milestones.ts`)
   - Update `validateMilestoneMultiVerifier()` to reject when the verifier is `suspended` or `deactivated`.
   - Ensure it checks verifier status from DB (not the in-memory test table).

4. **Audit blocked approvals**
   - When a blocked verifier attempts an approval in the multi-verifier flow, create audit log entry (likely from service or route).

5. **Tests** (`tests/**`)
   - Add test cases:
     - suspended verifier cannot approve.
     - reinstate allows approvals again.
     - historical approvals/votes remain in milestone_approvals table.
     - audit logs are written for suspend/reinstate and for blocked attempts.

6. **Docs / OpenAPI**
   - Ensure the RBAC spec endpoint list includes the reinstate route (or update openapi generator source if present).

## Notes
- Current `validateMilestoneMultiVerifier()` in `src/services/milestones.ts` appears to be an in-memory implementation (milestonesTable), which likely isn’t used by the DB-backed multi-verifier flow in `src/routes/milestones.ts`.
- DB-backed multi-verifier approvals are handled in `src/routes/milestones.ts` via `recordMilestoneApproval()` and `getMilestoneApprovalProgress()`.
- Therefore, we may need to add the blocking logic into the *DB-backed approval route* path as well, or ensure `validateMilestoneMultiVerifier()` is actually called there.

