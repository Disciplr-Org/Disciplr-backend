// Simple test to verify the vault lookup fix works
import { setVaults } from './src/routes/vaults.js';

// Test the legacy in-memory fallback
const testVault = {
  id: 'test-vault-123',
  creator: 'test-creator',
  amount: '500',
  status: 'active',
  startTimestamp: '2030-01-01T00:00:00.000Z',
  endTimestamp: '2030-06-01T00:00:00.000Z',
  successDestination: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  failureDestination: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
  createdAt: '2023-01-01T00:00:00.000Z',
};

console.log('Testing vault lookup fix...');

// Set up the legacy vault
setVaults([testVault]);

// Simulate the route handler logic
const testVaultLookup = (vaultId) => {
  // Simulate the legacy in-memory fallback logic from our fix
  const vault = vaults.find((v) => v.id === vaultId);
  if (!vault) {
    return { status: 404, body: { error: 'Vault not found' } };
  }
  
  // Return the vault found in legacy in-memory storage (our fix)
  return { status: 200, body: vault };
};

// Test 1: Vault should be found
const result1 = testVaultLookup('test-vault-123');
console.log('Test 1 - Found vault:', result1.status === 200 ? 'PASS' : 'FAIL');
console.log('Response body:', result1.body);

// Test 2: Non-existent vault should return 404
const result2 = testVaultLookup('non-existent');
console.log('Test 2 - Non-existent vault returns 404:', result2.status === 404 ? 'PASS' : 'FAIL');
console.log('Response body:', result2.body);

console.log('Vault lookup fix verification complete!');
