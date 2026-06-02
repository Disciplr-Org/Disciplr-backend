// src/tests/sorobanEnv.test.ts
import { describe, test, expect, afterEach, vi } from 'vitest';
import { validateEnv } from '../config/env.js';

describe('Soroban environment validation', () => {
  const baseEnv = {
    DATABASE_URL: 'postgres://postgres:postgres@localhost:5432/disciplr',
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

  test('partial Soroban configuration yields a warning', () => {
    const mockEnv = {
      ...baseEnv,
      SOROBAN_CONTRACT_ID: 'C' + 'A'.repeat(55),
    };
    const { warnings } = validateEnv(mockEnv);
    const partial = warnings.find((w) => w.message.includes('Partial Soroban'));
    expect(partial).toBeDefined();
    expect(partial?.variable).toBe('SOROBAN_*');
  });

  test('invalid contract id causes fatal validation failure', () => {
    const mockEnv = {
      ...baseEnv,
      SOROBAN_CONTRACT_ID: 'invalid-id',
    };
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process exit'); });
    // Also mock console.error to avoid cluttering test output
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => validateEnv(mockEnv)).toThrow('process exit');

    mockExit.mockRestore();
    mockConsoleError.mockRestore();
  });
});
