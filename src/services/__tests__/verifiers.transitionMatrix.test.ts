import { canTransition } from '../verifiers.js'

// Regression test for #1275: POST /:userId/reinstate computes
// nextStatus = verifier.approvedAt ? 'approved' : 'pending', but the
// transition matrix rejected deactivated -> approved, so a previously
// approved verifier could never actually be reinstated to 'approved' --
// the endpoint's own documented primary use case.
describe('canTransition (verifier status matrix)', () => {
  it('allows a deactivated verifier to be reinstated straight to approved', () => {
    expect(canTransition('deactivated', 'approved')).toBe(true)
  })

  it('still allows deactivated -> pending (reactivate flow)', () => {
    expect(canTransition('deactivated', 'pending')).toBe(true)
  })

  it('still allows deactivated -> deactivated (no-op / idempotent)', () => {
    expect(canTransition('deactivated', 'deactivated')).toBe(true)
  })

  it('does not allow deactivated -> suspended', () => {
    expect(canTransition('deactivated', 'suspended')).toBe(false)
  })

  it('leaves the other rows of the matrix unchanged', () => {
    expect(canTransition('pending', 'approved')).toBe(true)
    expect(canTransition('pending', 'suspended')).toBe(false)
    expect(canTransition('approved', 'suspended')).toBe(true)
    expect(canTransition('approved', 'pending')).toBe(false)
    expect(canTransition('suspended', 'approved')).toBe(true)
    expect(canTransition('suspended', 'pending')).toBe(false)
  })
})
