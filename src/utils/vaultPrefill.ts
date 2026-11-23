/**
 * vaultPrefill.ts
 *
 * Helpers for the "Duplicate Vault" flow.
 *
 * `createVaultPrefillFromVault` converts an existing PersistedVault into a
 * location.state payload suitable for React Router's `navigate()` call.
 *
 * `getCreateVaultPrefill` defensively parses that state back out on the
 * CreateVault page.  It guards against missing, null, or structurally
 * incorrect state (e.g. history cleared by the user or a hard-refresh).
 */

import type { PersistedVault, PersistedMilestone } from '../types/vaults.js';

// ── Types ────────────────────────────────────────────────────────────────────

/** Milestone fields carried across the navigation boundary. */
export interface PrefillMilestone {
  title: string;
  description: string | null;
  dueDate: string;
  amount: string;
}

/** The shape placed in router location.state under the createVaultPrefill key. */
export interface CreateVaultPrefill {
  amount: string;
  verifier: string;
  successDestination: string;
  failureDestination: string;
  milestones: PrefillMilestone[];
}

// ── Guards ───────────────────────────────────────────────────────────────────

/** Returns true when `v` is a non-null plain object. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Returns the value as a string when it is a non-empty string, otherwise undefined. */
function optionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the router location.state object from an existing vault.
 *
 * Usage (inside a component):
 *   navigate('/vaults/create', { state: createVaultPrefillFromVault(vault) });
 */
export function createVaultPrefillFromVault(
  vault: PersistedVault,
): { createVaultPrefill: CreateVaultPrefill } {
  const milestones: PrefillMilestone[] = vault.milestones.map(
    (m: PersistedMilestone) => ({
      title: m.title,
      description: m.description ?? null,
      dueDate: m.dueDate,
      amount: m.amount,
    }),
  );

  return {
    createVaultPrefill: {
      amount: vault.amount,
      verifier: vault.verifier,
      successDestination: vault.successDestination,
      failureDestination: vault.failureDestination,
      milestones,
    },
  };
}

/**
 * Defensively parse location.state back into a CreateVaultPrefill.
 *
 * Returns `undefined` when:
 *  - `state` is null / undefined / not a plain object.
 *  - `state.createVaultPrefill` is absent or not a plain object.
 *  - None of the expected string fields are present.
 *
 * The `milestones` array is filtered so that non-object entries are silently
 * dropped rather than causing downstream errors.
 *
 * Usage (inside CreateVault page):
 *   const prefill = getCreateVaultPrefill(location.state);
 */
export function getCreateVaultPrefill(
  state: unknown,
): CreateVaultPrefill | undefined {
  if (!isRecord(state)) return undefined;

  const raw = state['createVaultPrefill'];
  if (!isRecord(raw)) return undefined;

  const amount = optionalString(raw['amount']) ?? '';
  const verifier = optionalString(raw['verifier']) ?? '';
  const successDestination = optionalString(raw['successDestination']) ?? '';
  const failureDestination = optionalString(raw['failureDestination']) ?? '';

  // Filter out any array entries that are not plain objects so callers
  // receive a clean, typed array even if history.state has been corrupted.
  const rawMilestones = Array.isArray(raw['milestones'])
    ? raw['milestones']
    : [];

  const milestones: PrefillMilestone[] = rawMilestones
    .filter(isRecord)
    .map((m) => ({
      title: optionalString(m['title']) ?? '',
      description:
        m['description'] === null
          ? null
          : optionalString(m['description']) ?? null,
      dueDate: optionalString(m['dueDate']) ?? '',
      amount: optionalString(m['amount']) ?? '',
    }));

  return { amount, verifier, successDestination, failureDestination, milestones };
}
