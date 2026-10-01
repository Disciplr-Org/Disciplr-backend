import jwt from 'jsonwebtoken';
import { generateAccessToken, generateRefreshToken } from '../lib/auth-utils.js';

describe('JWT Key Rotation Header', () => {
  const originalEnv = process.env.JWT_KEYS;

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.JWT_KEYS = originalEnv;
    } else {
      delete process.env.JWT_KEYS;
    }
  });

  test('generateAccessToken includes kid and alg in header when rotation key is active', () => {
    process.env.JWT_KEYS = JSON.stringify([
      { kid: 'key-rot-1', secret: 'secret-key-rotation-1-long-enough-32-bytes' },
    ]);
    const token = generateAccessToken({ userId: 'user-123', role: 'USER' });
    const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string; alg?: string } } | null;
    expect(decoded).toBeDefined();
    expect(decoded?.header.kid).toBe('key-rot-1');
    expect(decoded?.header.alg).toBe('HS256');
  });

  test('generateRefreshToken includes kid and alg in header when rotation key is active', () => {
    process.env.JWT_KEYS = JSON.stringify([
      { kid: 'key-rot-1', secret: 'secret-key-rotation-1-long-enough-32-bytes' },
    ]);
    const token = generateRefreshToken({ userId: 'user-123' });
    const decoded = jwt.decode(token, { complete: true }) as { header: { kid?: string; alg?: string } } | null;
    expect(decoded).toBeDefined();
    expect(decoded?.header.kid).toBe('key-rot-1');
    expect(decoded?.header.alg).toBe('HS256');
  });
});
