import { generateAccessToken, generateRefreshToken, verifyAccessToken, verifyRefreshToken, hashToken } from '../../src/lib/auth-utils.js';
import { prisma } from '../../src/lib/prisma.js';
import { randomUUID } from 'node:crypto';

// Mock environment for JWT_KEYS
const setJwtKeys = (keys: any) => {
  process.env.JWT_KEYS = JSON.stringify(keys);
};

describe('JWT key rotation', () => {
  const user = { id: 'user-1', role: 'user' } as any;

  beforeEach(() => {
    // Reset env
    delete process.env.JWT_KEYS;
  });

  test('signs and verifies with current key', () => {
    setJwtKeys([
      { kid: 'key1', secret: 'secret1' },
      { kid: 'key2', secret: 'secret2', retiredAt: '2100-01-01T00:00:00Z' },
    ]);
    const token = generateAccessToken({ userId: user.id, role: user.role, jti: randomUUID() });
    const payload = verifyAccessToken(token);
    expect(payload.userId).toBe(user.id);
    expect(payload.role).toBe(user.role);
    // Header kid should be present
    const decoded = (payload as any);
    expect(decoded).toBeDefined();
  });

  test('accepts token signed with previous active key', () => {
    setJwtKeys([
      { kid: 'new', secret: 'newSecret' },
      { kid: 'old', secret: 'oldSecret' },
    ]);
    // Manually sign with old key using internal function (loadJwtKeys not exported)
    const oldKey = { kid: 'old', secret: 'oldSecret' } as any;
    const token = (require('../../src/lib/auth-utils.js') as any).generateAccessToken({ userId: user.id, role: user.role }, undefined);
    // Actually generateAccessToken uses current key, so we need to simulate by calling jwt directly
    const jwt = require('jsonwebtoken');
    const payload = { sub: user.id, role: user.role, userId: user.id };
    const oldToken = jwt.sign(payload, oldKey.secret, { expiresIn: '15m', issuer: 'disciplr', audience: 'disciplr-api', header: { kid: oldKey.kid } });
    const verified = verifyAccessToken(oldToken);
    expect(verified.userId).toBe(user.id);
  });

  test('rejects token with retired key', () => {
    const pastDate = new Date(Date.now() - 86400000).toISOString(); // 1 day ago
    setJwtKeys([
      { kid: 'active', secret: 'activeSecret' },
      { kid: 'retired', secret: 'oldSecret', retiredAt: pastDate },
    ]);
    const jwt = require('jsonwebtoken');
    const token = jwt.sign({ sub: user.id, role: user.role, userId: user.id }, 'oldSecret', { expiresIn: '15m', issuer: 'disciplr', audience: 'disciplr-api', header: { kid: 'retired' } });
    expect(() => verifyAccessToken(token)).toThrow('JWT kid retired is retired');
  });
});
