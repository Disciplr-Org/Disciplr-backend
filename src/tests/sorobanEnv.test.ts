// src/tests/sorobanEnv.test.ts
import { describe, test, expect } from '@jest/globals';
import { validateEnv } from '../config/env.js';

describe('Soroban environment validation', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/disciplr',
    // validateEnv requires DOWNLOAD_SECRET (min 16 chars); the old
    // vitest version of this file did not set it.
    DOWNLOAD_SECRET: 'test-download-secret-1234',
  };

  test('valid full Soroban configuration yields no warning', () => {
    const mockEnv = {
      ...baseEnv,
      SOROBAN_CONTRACT_ID: 'C' + 'A'.repeat(55),
      SOROBAN_NETWORK_PASSPHRASE: 'Test Network',
      SOROBAN_SOURCE_ACCOUNT: 'G' + 'B'.repeat(55),
      SOROBAN_RPC_URL: 'https://example.com/rpc',
      SOROBAN_SECRET_KEY: 'S' + 'C'.repeat(55),
    };
    const { env, warnings } = validateEnv(mockEnv);
    const partial = warnings.find((w) => w.message.includes('Partial Soroban'));
    expect(partial).toBeUndefined();
    expect(env.SOROBAN_CONTRACT_ID).toBe(mockEnv.SOROBAN_CONTRACT_ID);
  });

  test('partial Soroban configuration yields a warning with a populated field', () => {
    const mockEnv = {
      ...baseEnv,
      SOROBAN_CONTRACT_ID: 'C' + 'A'.repeat(55),
    };
    const { warnings } = validateEnv(mockEnv);
    // validateEnv (unlike initEnv) reports the partial-configuration
    // warning with field 'SOROBAN' and message 'Soroban is partially
    // configured (n/5 vars set)...', so match that shape here.
    const partial = warnings.find((w) => w.message.includes('partially configured'));
    expect(partial).toBeDefined();
    expect(partial?.field).toBe('SOROBAN');
    expect(partial?.message).toContain('partially configured');
  });

  test('invalid contract id causes fatal validation failure', () => {
    const mockEnv = {
      ...baseEnv,
      SOROBAN_CONTRACT_ID: 'invalid-id',
    };
    // validateEnv throws a validation error on a bad value; it never
    // calls process.exit (only initEnv exits on failure), so the old
    // process.exit spy and 'process exit' expectation were stale.
    expect(() => validateEnv(mockEnv)).toThrow('Environment validation failed');
  });
});
