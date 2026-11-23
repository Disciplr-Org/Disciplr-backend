import { describe, it, expect } from '@jest/globals';
import {
  createVaultPrefillFromVault,
  getCreateVaultPrefill,
} from '../../utils/vaultPrefill.js';
import type { PersistedVault } from '../../types/vaults.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function makeVault(overrides: Partial<PersistedVault> = {}): PersistedVault {
  return {
    id: 'vault-abc',
    amount: '5000',
    startDate: '2026-01-01T00:00:00.000Z',
    endDate: '2026-12-31T00:00:00.000Z',
    verifier: 'GVERIFIER000000000000000000000000000000000000000000000',
    successDestination: 'GSUCCESS00000000000000000000000000000000000000000000',
    failureDestination: 'GFAILURE00000000000000000000000000000000000000000000',
    creator: 'GCREATOR00000000000000000000000000000000000000000000',
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    lateCheckInWindowSecs: 0,
    milestones: [
      {
        id: 'ms-1',
        vaultId: 'vault-abc',
        title: 'First milestone',
        description: 'Complete phase 1',
        dueDate: '2026-06-01T00:00:00.000Z',
        amount: '2500',
        sortOrder: 0,
        verifierUserId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'ms-2',
        vaultId: 'vault-abc',
        title: 'Second milestone',
        description: null,
        dueDate: '2026-09-01T00:00:00.000Z',
        amount: '2500',
        sortOrder: 1,
        verifierUserId: null,
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

// ── Full round-trip ───────────────────────────────────────────────────────────

describe('vaultPrefill round-trip', () => {
  it('encodes a vault into location.state and parses it back without loss', () => {
    const vault = makeVault();
    const state = createVaultPrefillFromVault(vault);

    // Simulate React Router serialising and deserialising via history.state
    // (structured-clone semantics: a plain JSON-equivalent object).
    const parsed = getCreateVaultPrefill(state);

    expect(parsed).toBeDefined();
    expect(parsed!.amount).toBe('5000');
    expect(parsed!.verifier).toBe(vault.verifier);
    expect(parsed!.successDestination).toBe(vault.successDestination);
    expect(parsed!.failureDestination).toBe(vault.failureDestination);

    expect(parsed!.milestones).toHaveLength(2);

    const [first, second] = parsed!.milestones;
    expect(first.title).toBe('First milestone');
    expect(first.description).toBe('Complete phase 1');
    expect(first.dueDate).toBe('2026-06-01T00:00:00.000Z');
    expect(first.amount).toBe('2500');

    // Null description must survive the round-trip as null (not undefined or '').
    expect(second.description).toBeNull();
  });

  it('produces a location.state object with a createVaultPrefill key', () => {
    const state = createVaultPrefillFromVault(makeVault());
    expect(state).toHaveProperty('createVaultPrefill');
    expect(typeof state.createVaultPrefill).toBe('object');
  });

  it('maps an empty milestones array correctly', () => {
    const vault = makeVault({ milestones: [] });
    const state = createVaultPrefillFromVault(vault);
    const parsed = getCreateVaultPrefill(state);
    expect(parsed!.milestones).toEqual([]);
  });
});

// ── Missing / undefined state ─────────────────────────────────────────────────

describe('getCreateVaultPrefill – missing or undefined state', () => {
  it('returns undefined when state is undefined', () => {
    expect(getCreateVaultPrefill(undefined)).toBeUndefined();
  });

  it('returns undefined when state is null', () => {
    expect(getCreateVaultPrefill(null)).toBeUndefined();
  });

  it('returns undefined when state is a primitive string', () => {
    expect(getCreateVaultPrefill('some-string')).toBeUndefined();
  });

  it('returns undefined when state is a number', () => {
    expect(getCreateVaultPrefill(42)).toBeUndefined();
  });

  it('returns undefined when state is an array', () => {
    expect(getCreateVaultPrefill([])).toBeUndefined();
  });
});

// ── State object without a createVaultPrefill key ─────────────────────────────

describe('getCreateVaultPrefill – state missing the createVaultPrefill key', () => {
  it('returns undefined when the state object has no createVaultPrefill property', () => {
    expect(getCreateVaultPrefill({ someOtherKey: 'value' })).toBeUndefined();
  });

  it('returns undefined when createVaultPrefill is null', () => {
    expect(getCreateVaultPrefill({ createVaultPrefill: null })).toBeUndefined();
  });

  it('returns undefined when createVaultPrefill is a string instead of an object', () => {
    expect(
      getCreateVaultPrefill({ createVaultPrefill: 'not-an-object' }),
    ).toBeUndefined();
  });

  it('returns undefined when createVaultPrefill is an array', () => {
    expect(getCreateVaultPrefill({ createVaultPrefill: [] })).toBeUndefined();
  });
});

// ── Milestones array with non-object entries (isRecord guard) ─────────────────

describe('getCreateVaultPrefill – milestones filtering via isRecord guard', () => {
  it('filters out non-object milestone entries and keeps valid ones', () => {
    const state = {
      createVaultPrefill: {
        amount: '1000',
        verifier: 'GVERIFIER',
        successDestination: 'GSUCCESS',
        failureDestination: 'GFAILURE',
        milestones: [
          // valid object entry
          {
            title: 'Valid',
            description: 'OK',
            dueDate: '2026-06-01T00:00:00.000Z',
            amount: '500',
          },
          // should be filtered out – primitive
          'not-an-object',
          // should be filtered out – number
          42,
          // should be filtered out – null
          null,
          // should be filtered out – array
          ['nested', 'array'],
          // another valid object
          {
            title: 'Also valid',
            description: null,
            dueDate: '2026-09-01T00:00:00.000Z',
            amount: '500',
          },
        ],
      },
    };

    const parsed = getCreateVaultPrefill(state);
    expect(parsed).toBeDefined();

    // Only the two plain-object entries survive.
    expect(parsed!.milestones).toHaveLength(2);
    expect(parsed!.milestones[0].title).toBe('Valid');
    expect(parsed!.milestones[1].title).toBe('Also valid');
  });

  it('returns an empty milestones array when every entry is non-object', () => {
    const state = {
      createVaultPrefill: {
        amount: '1000',
        verifier: 'GVERIFIER',
        successDestination: 'GSUCCESS',
        failureDestination: 'GFAILURE',
        milestones: ['string', 99, null, undefined, true],
      },
    };

    const parsed = getCreateVaultPrefill(state);
    expect(parsed!.milestones).toEqual([]);
  });

  it('treats a missing milestones key as an empty array', () => {
    const state = {
      createVaultPrefill: {
        amount: '500',
        verifier: 'GVERIFIER',
        successDestination: 'GSUCCESS',
        failureDestination: 'GFAILURE',
        // milestones deliberately omitted
      },
    };

    const parsed = getCreateVaultPrefill(state);
    expect(parsed!.milestones).toEqual([]);
  });
});
