import { toPublicVault, toPublicMilestone } from '../utils/mappers.js';
import { maskPii } from '../utils/privacy.js';
import { Milestone } from '../types/horizonSync.js';
import { Vault, VaultStatus } from '../types/vault.js';

describe('Enterprise API Exposure Audit', () => {
  const mockInternalVault: Vault = {
    id: 'vault_123',
    contract_id: 'C123',
    creator_address: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ',
    amount: '1000.0000000',
    deadline: new Date('2024-12-31T23:59:59Z'),
    milestone_hash: 'hash',
    verifier_address: 'GVERIFIER',
    success_destination: 'GBBM6BKZPEHWYO3E3YKREDPQXMS4VK35YLNU7NFBRI26RAN7GI5POFBB',
    failure_destination: 'GDTNXRLOJD2YEBPKK7KCMR7J33AAG5VZXHAJTHIG736D6LVEFLLLKPDL',
    status: VaultStatus.ACTIVE,
    created_at: new Date('2024-01-01T00:00:00Z'),
    updated_at: new Date()
  };

  test('toPublicVault should omit internal fields', () => {
    const result = toPublicVault(mockInternalVault);

    // Verify expected fields are present
    expect(result.id).toBe(mockInternalVault.id);
    expect(result.creator).toBe(mockInternalVault.creator_address);
    expect(result.amount).toBe(mockInternalVault.amount);

    // Verify internal fields are strictly omitted
    expect(result).not.toHaveProperty('created_at');
    expect(result).not.toHaveProperty('updated_at');
    
    // Verify date format conversion
    expect(typeof result.startTimestamp).toBe('string');
    expect(result.endTimestamp).toBe('2024-12-31T23:59:59.000Z');
  });

  test('JSON serialization should not leak undefined keys', () => {
    const publicVault = toPublicVault(mockInternalVault);
    const json = JSON.stringify(publicVault);
    const parsed = JSON.parse(json);

    expect(parsed.createdAt).toBeUndefined();
    expect(Object.keys(parsed)).toHaveLength(8); // id, creator, amount, status, start, end, success, failure
  });

  test('toPublicMilestone should omit internal fields', () => {
    const mockMilestone: Milestone = {
      id: 'm_1',
      vaultId: 'v_1',
      title: 'Phase 1',
      description: 'Test',
      targetAmount: '500',
      currentAmount: '0',
      deadline: new Date(),
      status: 'pending',
      createdAt: new Date(),
      updatedAt: new Date()
    };

    const result = toPublicMilestone(mockMilestone);
    expect(result).not.toHaveProperty('createdAt');
    expect(result).not.toHaveProperty('updatedAt');
    expect(result.id).toBe(mockMilestone.id);
  });

  test('maskPii should produce deterministic 8-char hash', () => {
    const address = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ';
    const hash = maskPii(address);
    expect(hash).toHaveLength(8);
    expect(maskPii(address)).toBe(hash); // Deterministic
  });

  test('EnterpriseVault DTO should never contain organization_id', () => {
    const internalVault = {
      ...mockInternalVault,
      organization_id: 'org_123'
    };
    const result = toPublicVault(internalVault as any);
    expect(result).not.toHaveProperty('organization_id');
    expect(result).not.toHaveProperty('user_id');
  });

  test('toPublicMilestone should strip all metadata fields', () => {
    const mockMilestone: any = {
      id: 'm_1',
      vaultId: 'v_1',
      deadline: new Date(),
      metadata: { secret: 'data' },
      internal_notes: 'private',
      status: 'pending'
    };

    const result = toPublicMilestone(mockMilestone);
    expect(result).not.toHaveProperty('metadata');
    expect(result).not.toHaveProperty('internal_notes');
    expect(result.status).toBe('pending');
  });
});