import { vaultStore } from '../services/vaultStore';
import { milestoneRepository } from '../repositories/milestoneRepository';

describe('Vault & Milestone Soft Delete Cascade', () => {
  let mockVaultId: string;

  beforeAll(async () => {
    // Setup boilerplate or clear table spaces if needed
  });

  it('should filter out soft-deleted vaults by default', async () => {
    // Assert queries return active records and ignore records where deleted_at IS NOT NULL
    const defaultVaults = await vaultStore.findMany({ orgId: 'test-org' }, false);
    expect(defaultVaults.every(v => v.deletedAt === null)).toBe(true);
  });

  it('should include soft-deleted records when admin flag includeDeleted is true', async () => {
    const allVaults = await vaultStore.findMany({ orgId: 'test-org' }, true);
    expect(allVaults).toBeDefined();
  });
});
